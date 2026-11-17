import { createHash, createHmac, randomBytes } from "node:crypto";

import { Prisma, type Role } from "@prisma/client";
import { addDays } from "date-fns";
import { z } from "zod";

import { db } from "@/lib/db";
import { appLink } from "@/lib/mail/origin";
import { inviteEmail } from "@/lib/mail/templates";
import { hasRole, ROLE_LABELS } from "@/lib/roles";
import { getStorage, keyBelongsToWorkspace, type StorageDriver } from "@/lib/storage";
import { isReservedSlug, SLUG_MAX, SLUG_MIN, SLUG_PATTERN } from "@/lib/slug";
import type { TenantContext } from "@/lib/tenant-context";
import { conflict, forbidden, notFound, parseInput, ServiceError } from "@/server/errors";
import { recordMemberJoined, recordMembershipRemoved, recordRoleChanged } from "@/server/activity";
import { queueMail, type MailStatus } from "@/server/mail";
import { notifyMemberJoined } from "@/server/notifications";

type Tx = Prisma.TransactionClient;

export const INVITE_TTL_DAYS = 7;

// ----------------------------------------------------------- schemas ----

const emailSchema = z
  .string({ error: "E-posta gerekli." })
  .trim()
  .toLowerCase()
  .pipe(z.email("Geçerli bir e-posta adresi girin."));

const roleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"], { error: "Geçersiz rol." });

export const workspaceNameSchema = z
  .string({ error: "Ad gerekli." })
  .trim()
  .min(2, "Ad en az 2 karakter olmalı.")
  .max(60, "Ad en fazla 60 karakter olabilir.");

export const slugSchema = z
  .string({ error: "Adres gerekli." })
  .trim()
  .toLowerCase()
  .min(SLUG_MIN, `Adres en az ${SLUG_MIN} karakter olmalı.`)
  .max(SLUG_MAX, `Adres en fazla ${SLUG_MAX} karakter olabilir.`)
  .regex(SLUG_PATTERN, "Yalnızca küçük harf, rakam ve tire kullanın; tire ile başlayıp bitmesin.")
  .refine((s) => !isReservedSlug(s), "Bu adres ayrılmış, başka bir adres seçin.");

const createWorkspaceSchema = z.object({ name: workspaceNameSchema, slug: slugSchema });
const inviteSchema = z.object({ email: emailSchema, role: roleSchema });
// Link invites never grant OWNER: a link can be forwarded to anyone.
const inviteLinkSchema = z.object({ role: z.enum(["MEMBER", "ADMIN"], { error: "Geçersiz rol." }) });
const idSchema = z.string().min(1).max(64);

// ----------------------------------------------------------- helpers ----

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Link invites are reusable, so the admin must be able to copy the link again
 * later. The token is derived from the invitation id with a server secret
 * (HMAC) instead of being stored: the DB only holds its SHA-256 hash, and a
 * database leak alone cannot rebuild a working link.
 */
export function inviteLinkToken(invitationId: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  const mac = createHmac("sha256", `invite-link:${secret}`).update(invitationId).digest("base64url");
  return `${invitationId}.${mac}`;
}

/**
 * Lock the workspace row so concurrent membership changes are serialised
 * (protects the "at least one OWNER" invariant), then re-read the actor's
 * membership from the DB so a stale or forged ctx cannot act.
 */
async function lockAndLoadActor(tx: Tx, ctx: TenantContext) {
  await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${ctx.workspaceId} FOR UPDATE`;
  const actor = await tx.membership.findUnique({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
  });
  if (!actor) throw notFound("Çalışma alanı bulunamadı.");
  return actor;
}

async function countOwners(tx: Tx, workspaceId: string) {
  return tx.membership.count({ where: { workspaceId, role: "OWNER" } });
}

// -------------------------------------------------- workspace (no ctx) ----

/** Workspaces the user belongs to, newest membership first. */
export async function listUserWorkspaces(userId: string) {
  const rows = await db.membership.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: {
      workspace: { include: { _count: { select: { memberships: true } } } },
    },
  });
  return rows.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    role: m.role,
    memberCount: m.workspace._count.memberships,
  }));
}

/**
 * Create a workspace; the creator becomes OWNER in the same transaction.
 * Not ctx-scoped because no workspace exists yet - `actor.userId` must come
 * from the session (requireUser()).
 */
export async function createWorkspace(actor: { userId: string }, input: unknown) {
  const data = parseInput(createWorkspaceSchema, input);
  try {
    return await db.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({ data: { name: data.name, slug: data.slug } });
      await tx.membership.create({
        data: { workspaceId: workspace.id, userId: actor.userId, role: "OWNER" },
      });
      return workspace;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ServiceError("CONFLICT", "Bu adres zaten kullanılıyor.", {
        slug: ["Bu adres zaten kullanılıyor."],
      });
    }
    throw e;
  }
}

// --------------------------------------------------------- ctx-scoped ----

export async function getWorkspaceSummary(ctx: TenantContext) {
  const workspace = await db.workspace.findUnique({
    where: { id: ctx.workspaceId },
    include: { _count: { select: { memberships: true } } },
  });
  if (!workspace) throw notFound("Çalışma alanı bulunamadı.");
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    createdAt: workspace.createdAt,
    memberCount: workspace._count.memberships,
  };
}

export async function renameWorkspace(ctx: TenantContext, input: unknown) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden();
  const name = parseInput(z.object({ name: workspaceNameSchema }), input).name;
  return db.$transaction(async (tx) => {
    const actor = await lockAndLoadActor(tx, ctx);
    if (!hasRole(actor.role, "ADMIN")) throw forbidden();
    return tx.workspace.update({ where: { id: ctx.workspaceId }, data: { name } });
  });
}

/**
 * Permanently delete the workspace and everything in it. OWNER only; the
 * caller must type the workspace slug. Rows go first (cascade), then the
 * stored objects are removed best-effort through the storage driver: the
 * File and UploadKey keys, then everything left under "<workspaceId>/"
 * (bytes of uploads that were PUT but never completed have no row).
 *
 * Known gap (R2 only): a presigned PUT handed out just before the delete
 * stays valid for UPLOAD_URL_TTL_S and can still land after this sweep.
 * Closing it needs a periodic sweep of deleted-workspace prefixes or a
 * bucket lifecycle rule (neither exists yet).
 */
export async function deleteWorkspace(
  ctx: TenantContext,
  input: unknown,
  storage: StorageDriver = getStorage(),
) {
  if (ctx.role !== "OWNER") throw forbidden("Çalışma alanını yalnızca sahipler silebilir.");
  const { confirmSlug } = parseInput(
    z.object({ confirmSlug: z.string({ error: "Adresi yazarak onaylayın." }).trim().toLowerCase() }),
    input,
  );

  const keys = await db.$transaction(async (tx) => {
    const actor = await lockAndLoadActor(tx, ctx);
    if (actor.role !== "OWNER") throw forbidden("Çalışma alanını yalnızca sahipler silebilir.");
    const workspace = await tx.workspace.findUnique({
      where: { id: ctx.workspaceId },
      select: { slug: true },
    });
    if (!workspace) throw notFound("Çalışma alanı bulunamadı.");
    if (confirmSlug !== workspace.slug) {
      throw new ServiceError("VALIDATION", "Onay için çalışma alanı adresini doğru yazın.", {
        confirmSlug: ["Onay için çalışma alanı adresini doğru yazın."],
      });
    }
    const [files, pending] = await Promise.all([
      tx.file.findMany({ where: { workspaceId: ctx.workspaceId }, select: { storageKey: true } }),
      tx.uploadKey.findMany({ where: { workspaceId: ctx.workspaceId }, select: { storageKey: true } }),
    ]);
    await tx.workspace.delete({ where: { id: ctx.workspaceId } });
    return [...new Set([...files, ...pending].map((r) => r.storageKey))];
  });

  const owned = keys.filter((k) => keyBelongsToWorkspace(k, ctx.workspaceId));
  const results = await Promise.allSettled(owned.map((k) => storage.delete(k)));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[workspaces] could not delete storage object ${owned[i]}`, r.reason);
    }
  });
  try {
    await storage.deleteWorkspaceObjects(ctx.workspaceId);
  } catch (e) {
    console.error(`[workspaces] could not sweep storage prefix ${ctx.workspaceId}/`, e);
  }
  return { deletedObjects: owned.length };
}

export async function listMembers(ctx: TenantContext) {
  const rows = await db.membership.findMany({
    where: { workspaceId: ctx.workspaceId },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
  });
  const order: Record<Role, number> = { OWNER: 0, ADMIN: 1, MEMBER: 2 };
  return rows
    .map((m) => ({
      id: m.id,
      role: m.role,
      createdAt: m.createdAt,
      user: m.user,
    }))
    .sort(
      (a, b) =>
        order[a.role] - order[b.role] ||
        (a.user.name ?? a.user.email).localeCompare(b.user.name ?? b.user.email, "tr"),
    );
}

/** Members as {id, name, email, image} - handy for assignee pickers. */
export async function listMemberUsers(ctx: TenantContext) {
  const members = await listMembers(ctx);
  return members.map((m) => m.user);
}

/** True when `userId` is a member of ctx's workspace (use to validate assignees etc.). */
export async function isWorkspaceMember(ctx: TenantContext, userId: string): Promise<boolean> {
  const m = await db.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: ctx.workspaceId } },
    select: { id: true },
  });
  return Boolean(m);
}

export async function listPendingInvitations(ctx: TenantContext) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden();
  const rows = await db.invitation.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      acceptedAt: null,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      reusable: true,
      useCount: true,
      expiresAt: true,
      createdAt: true,
      invitedBy: { select: { name: true, email: true } },
    },
  });
  return rows.map((r) => ({ ...r, linkToken: r.reusable ? inviteLinkToken(r.id) : null }));
}

/**
 * Create an invitation. Returns the raw token ONCE (only its hash is stored);
 * the caller shows /invite/<token> to the inviter. The invite email is
 * written to the outbox after the commit; `deliverEmail` sends it (SMTP
 * driver) and never throws - a mail problem never fails the invite, the
 * copyable link keeps working.
 */
export async function createInvitation(ctx: TenantContext, input: unknown) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden();
  const data = parseInput(inviteSchema, input);

  const result = await db.$transaction(async (tx) => {
    const actor = await lockAndLoadActor(tx, ctx);
    if (!hasRole(actor.role, "ADMIN")) throw forbidden();
    if (data.role === "OWNER" && actor.role !== "OWNER") {
      throw forbidden("Sahip rolüyle yalnızca sahipler davet gönderebilir.");
    }

    const existingMember = await tx.membership.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        user: { email: { equals: data.email, mode: "insensitive" } },
      },
      select: { id: true },
    });
    if (existingMember) {
      throw new ServiceError("CONFLICT", "Bu kişi zaten çalışma alanının üyesi.", {
        email: ["Bu kişi zaten çalışma alanının üyesi."],
      });
    }

    // A new invite replaces any still-pending invite for the same email.
    await tx.invitation.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        email: data.email,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    const token = generateInviteToken();
    const invitation = await tx.invitation.create({
      data: {
        workspaceId: ctx.workspaceId,
        email: data.email,
        role: data.role,
        tokenHash: hashInviteToken(token),
        invitedById: ctx.userId,
        expiresAt: addDays(new Date(), INVITE_TTL_DAYS),
      },
    });
    return { invitation, token };
  });
  const deliverEmail = await queueInvitationEmail(
    ctx,
    { ...result.invitation, email: data.email, expiresAt: result.invitation.expiresAt ?? addDays(new Date(), INVITE_TTL_DAYS) },
    result.token,
  );
  return { ...result, invitation: { ...result.invitation, email: data.email }, deliverEmail };
}

/**
 * Create a reusable invite LINK (no e-mail address needed). Anyone who opens
 * it while signed in can join with the chosen role, any number of times,
 * until an admin revokes it. Returns the token (it can be rebuilt later with
 * inviteLinkToken(invitation.id)).
 */
export async function createInviteLink(ctx: TenantContext, input: unknown) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden();
  const data = parseInput(inviteLinkSchema, input);
  return db.$transaction(async (tx) => {
    const actor = await lockAndLoadActor(tx, ctx);
    if (!hasRole(actor.role, "ADMIN")) throw forbidden();
    const id = randomBytes(15).toString("hex");
    const token = inviteLinkToken(id);
    const invitation = await tx.invitation.create({
      data: {
        id,
        workspaceId: ctx.workspaceId,
        email: null,
        role: data.role,
        reusable: true,
        tokenHash: hashInviteToken(token),
        invitedById: ctx.userId,
        expiresAt: null,
      },
    });
    return { invitation, token };
  });
}

const failedDelivery = async (): Promise<MailStatus> => "failed";

/** Builds and queues the invite email. Errors are logged, never thrown. */
async function queueInvitationEmail(
  ctx: TenantContext,
  invitation: { email: string; role: Role; expiresAt: Date },
  token: string,
): Promise<() => Promise<MailStatus>> {
  try {
    const [workspace, inviter] = await Promise.all([
      db.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { name: true } }),
      db.user.findUnique({ where: { id: ctx.userId }, select: { name: true, email: true } }),
    ]);
    if (!workspace || !inviter) return failedDelivery;
    const content = inviteEmail({
      workspaceName: workspace.name,
      inviterName: inviter.name?.trim() || inviter.email,
      roleLabel: ROLE_LABELS[invitation.role].toLocaleLowerCase("tr"),
      // Trusted origin (AUTH_URL), never the request's Host header.
      link: appLink(`/invite/${token}`),
      expiresAt: invitation.expiresAt,
    });
    const queued = await queueMail({ to: invitation.email, ...content, kind: "invite" });
    return queued.deliver;
  } catch (e) {
    console.error("[workspaces] invite email failed:", e instanceof Error ? e.message : e);
    return failedDelivery;
  }
}

export async function revokeInvitation(ctx: TenantContext, invitationId: string) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden();
  const id = parseInput(idSchema, invitationId);
  return db.$transaction(async (tx) => {
    const actor = await lockAndLoadActor(tx, ctx);
    if (!hasRole(actor.role, "ADMIN")) throw forbidden();
    const invite = await tx.invitation.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (!invite) throw notFound("Davet bulunamadı.");
    if (invite.role === "OWNER" && actor.role !== "OWNER") {
      throw forbidden("Sahip davetlerini yalnızca sahipler iptal edebilir.");
    }
    if (invite.acceptedAt) throw conflict("Bu davet zaten kabul edilmiş.");
    if (invite.revokedAt) return invite;
    return tx.invitation.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
  });
}

export async function changeMemberRole(ctx: TenantContext, membershipId: string, newRole: unknown) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden();
  const id = parseInput(idSchema, membershipId);
  const role = parseInput(roleSchema, newRole);

  let changed = false;
  const updated = await db.$transaction(async (tx) => {
    const actor = await lockAndLoadActor(tx, ctx);
    if (!hasRole(actor.role, "ADMIN")) throw forbidden();
    const target = await tx.membership.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (!target) throw notFound("Üye bulunamadı.");
    if (target.role === role) return target;
    if ((target.role === "OWNER" || role === "OWNER") && actor.role !== "OWNER") {
      throw forbidden("Sahip rolünü yalnızca sahipler verebilir veya değiştirebilir.");
    }
    if (target.role === "OWNER" && (await countOwners(tx, ctx.workspaceId)) <= 1) {
      throw conflict("Çalışma alanında en az bir sahip kalmalı.");
    }
    if (!hasRole(role, target.role)) {
      // Demotion: pending invites the target can no longer grant stop working.
      await revokeInvitesSentBy(tx, ctx.workspaceId, target.userId, role);
    }
    changed = true;
    return tx.membership.update({ where: { id: target.id }, data: { role } });
  });
  if (changed) await recordRoleChanged(ctx, updated); // after commit; never throws
  return updated;
}

/**
 * Revokes the still-pending invitations `inviterId` sent in this workspace
 * that `remainingRole` may no longer grant (null = no longer a member: all).
 */
async function revokeInvitesSentBy(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  inviterId: string,
  remainingRole: Role | null,
) {
  if (remainingRole === "OWNER") return;
  await tx.invitation.updateMany({
    where: {
      workspaceId,
      invitedById: inviterId,
      acceptedAt: null,
      revokedAt: null,
      ...(remainingRole === "ADMIN" ? { role: "OWNER" as const } : {}),
    },
    data: { revokedAt: new Date() },
  });
}

/** True when an inviter holding `inviterRole` (null = not a member) may still grant `invitedRole`. */
function inviterCanGrant(inviterRole: Role | null, invitedRole: Role): boolean {
  if (!inviterRole || !hasRole(inviterRole, "ADMIN")) return false;
  return invitedRole !== "OWNER" || inviterRole === "OWNER";
}

export async function removeMember(ctx: TenantContext, membershipId: string) {
  const id = parseInput(idSchema, membershipId);
  const result = await db.$transaction(async (tx) => {
    const actor = await lockAndLoadActor(tx, ctx);
    const target = await tx.membership.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (!target) throw notFound("Üye bulunamadı.");
    const isSelf = target.userId === actor.userId;
    if (!isSelf && !hasRole(actor.role, "ADMIN")) throw forbidden();
    if (!isSelf && target.role === "OWNER" && actor.role !== "OWNER") {
      throw forbidden("Bir sahibi yalnızca başka bir sahip çıkarabilir.");
    }
    if (target.role === "OWNER" && (await countOwners(tx, ctx.workspaceId)) <= 1) {
      throw conflict(
        isSelf
          ? "Son sahip olarak ayrılamazsınız. Önce başka bir üyeyi sahip yapın."
          : "Çalışma alanında en az bir sahip kalmalı.",
      );
    }
    await revokeInvitesSentBy(tx, ctx.workspaceId, target.userId, null);
    await tx.membership.delete({ where: { id: target.id } });
    // A former member keeps nothing readable here: drop their notifications.
    await tx.notification.deleteMany({
      where: { workspaceId: ctx.workspaceId, userId: target.userId },
    });
    return { removedUserId: target.userId };
  });
  await recordMembershipRemoved(ctx, result.removedUserId); // after commit; never throws
  return result;
}

/** The signed-in member leaves the workspace (blocked for the last OWNER). */
export async function leaveWorkspace(ctx: TenantContext) {
  const own = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
    select: { id: true },
  });
  if (!own) throw notFound("Çalışma alanı bulunamadı.");
  return removeMember(ctx, own.id);
}

// ------------------------------------------------- invitations by token ----

export type InvitationStatus = "valid" | "expired" | "revoked" | "accepted";

/**
 * Public preview for /invite/[token]. Returns null when the token is unknown.
 * Pass the signed-in viewer's id to learn whether they are already a member.
 */
export async function getInvitationByToken(token: string, viewerUserId?: string | null) {
  if (typeof token !== "string" || token.length < 20 || token.length > 128) return null;
  const invite = await db.invitation.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: {
      workspace: { select: { id: true, name: true, slug: true } },
      invitedBy: { select: { name: true, email: true } },
    },
  });
  if (!invite) return null;
  const status: InvitationStatus = invite.acceptedAt && !invite.reusable
    ? "accepted"
    : invite.revokedAt
      ? "revoked"
      : invite.expiresAt && invite.expiresAt <= new Date()
        ? "expired"
        : "valid";
  const viewerIsMember = viewerUserId
    ? Boolean(
        await db.membership.findUnique({
          where: { userId_workspaceId: { userId: viewerUserId, workspaceId: invite.workspaceId } },
          select: { id: true },
        }),
      )
    : false;
  return {
    id: invite.id,
    viewerIsMember,
    email: invite.email,
    reusable: invite.reusable,
    role: invite.role,
    expiresAt: invite.expiresAt,
    status,
    workspace: invite.workspace,
    invitedBy: invite.invitedBy,
  };
}

/**
 * Accept an invitation. `actor` must come from the session.
 * Atomic + single-use; idempotent when the user is already a member.
 */
export async function acceptInvitation(actor: { userId: string; email: string }, token: string) {
  if (typeof token !== "string" || token.length < 20 || token.length > 128) {
    throw notFound("Davet bulunamadı.");
  }
  const tokenHash = hashInviteToken(token);

  const result = await db.$transaction(async (tx) => {
    const invite = await tx.invitation.findUnique({
      where: { tokenHash },
      include: { workspace: { select: { id: true, name: true, slug: true } } },
    });
    if (!invite) throw notFound("Davet bulunamadı.");

    // Link invites (reusable) are open to any signed-in user; e-mail invites are bound to an address.
    if (!invite.reusable && invite.email?.toLowerCase() !== actor.email.trim().toLowerCase()) {
      throw forbidden(
        "Bu davet başka bir e-posta adresine gönderilmiş. Davet edilen adresle giriş yapın.",
      );
    }

    const existing = await tx.membership.findUnique({
      where: { userId_workspaceId: { userId: actor.userId, workspaceId: invite.workspaceId } },
    });

    if (existing) {
      // Idempotent: already a member. Consume a still-pending invite.
      if (!invite.reusable && !invite.acceptedAt && !invite.revokedAt) {
        await tx.invitation.updateMany({
          where: { id: invite.id, acceptedAt: null, revokedAt: null },
          data: { acceptedAt: new Date() },
        });
      }
      return { workspace: invite.workspace, membership: existing, alreadyMember: true };
    }

    if (invite.acceptedAt && !invite.reusable) throw conflict("Bu davet zaten kullanılmış.");
    if (invite.revokedAt) throw conflict("Bu davet iptal edilmiş.");
    if (invite.expiresAt && invite.expiresAt <= new Date()) throw conflict("Bu davetin süresi dolmuş.");

    // The inviter must STILL be allowed to grant this role (they may have been
    // demoted or removed since the invite was created).
    const inviter = await tx.membership.findUnique({
      where: { userId_workspaceId: { userId: invite.invitedById, workspaceId: invite.workspaceId } },
      select: { role: true },
    });
    if (!inviterCanGrant(inviter?.role ?? null, invite.role)) {
      throw conflict("Bu davet artık geçerli değil. Yeni bir davet isteyin.");
    }

    if (invite.reusable) {
      // Link invite: never consumed, just counted. Revocation/expiry are re-checked atomically.
      const counted = await tx.invitation.updateMany({
        where: {
          id: invite.id,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        data: { useCount: { increment: 1 } },
      });
      if (counted.count !== 1) throw conflict("Bu davet artık geçerli değil.");
    } else {
      // Single-use guard: only one concurrent request can flip acceptedAt.
      const claimed = await tx.invitation.updateMany({
        where: {
          id: invite.id,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count !== 1) throw conflict("Bu davet zaten kullanılmış.");
    }
    // Never touch emailVerified here: the inviter holds the raw token (it is
    // the copyable link), so redeeming it proves nothing about the inbox.

    // A rejoining user starts clean: never inherit rows left from an earlier
    // membership (e.g. one that raced with removeMember).
    await tx.notification.deleteMany({
      where: { workspaceId: invite.workspaceId, userId: actor.userId },
    });
    const membership = await tx.membership.create({
      data: { userId: actor.userId, workspaceId: invite.workspaceId, role: invite.role },
    });
    return { workspace: invite.workspace, membership, alreadyMember: false };
  });
  // A real join (not an idempotent re-accept): tell the OWNERs and ADMINs.
  // After the commit, so the new member's ctx is backed by a real membership.
  if (!result.alreadyMember) {
    await notifyMemberJoined({
      userId: actor.userId,
      workspaceId: result.workspace.id,
      role: result.membership.role,
    });
    await recordMemberJoined({ userId: actor.userId, workspaceId: result.workspace.id, role: result.membership.role });
  }
  return result;
}
