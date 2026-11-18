import type { Prisma, Role } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { istanbulDayKey } from "@/lib/istanbul-time";
import { isGuest } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { notFound, parseInput, ServiceError } from "@/server/errors";

/**
 * In-app notifications ("Bildirimler").
 *
 * Writing: notify() and the notifyX() trigger helpers are called by other
 * services AFTER their main write. They never throw: a failure is logged and
 * swallowed so it can never fail the user's action. Rows are only created for
 * recipients that are current members of ctx.workspaceId (checked in the DB),
 * and never for the actor.
 *
 * Team-only content: pass `internal: true` and guests are dropped from the
 * recipients (a guest must never be told about an item they cannot open).
 *
 * Reading: every read/update is scoped by userId = ctx.userId AND
 * workspaceId = ctx.workspaceId, so a user only ever sees or touches their
 * own notifications in the current workspace.
 */

export const NOTIFICATION_TYPES = [
  "TODO_ASSIGNED",
  "POST_CREATED",
  "POST_COMMENT",
  /** A comment on a to-do, document or event (posts keep POST_COMMENT). */
  "COMMENT",
  /** "@Name" in a post or comment. */
  "MENTION",
  "EVENT_CREATED",
  "MEMBER_JOINED",
  /** A direct message in the chat. */
  "CHAT_DM",
  /** A scheduled automatic check-in question. */
  "CHECKIN",
  /** You were invited to a calendar event. */
  "EVENT_INVITE",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Workspace-relative path: lowercase first segment, optional id segments, an
 * optional simple query and an optional fragment. No scheme (":" is not
 * allowed), no leading slash, no "." at all (so no ".."), no "//".
 * Examples: "todos", "messages/ck123", "calendar?month=2026-11#agenda-2026-11-12".
 */
export const NOTIFICATION_PATH_PATTERN =
  /^[a-z][a-z0-9-]{0,31}(?:\/[A-Za-z0-9_-]{1,64}){0,3}(?:\?[A-Za-z0-9_-]{1,32}=[A-Za-z0-9_-]{0,64}(?:&[A-Za-z0-9_-]{1,32}=[A-Za-z0-9_-]{0,64}){0,3})?(?:#[A-Za-z0-9_-]{1,100})?$/;
export const NOTIFICATION_PATH_MAX = 300;

export function isValidNotificationPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= NOTIFICATION_PATH_MAX &&
    NOTIFICATION_PATH_PATTERN.test(path)
  );
}

/** Path to link to; falls back to the notifications page for anything unexpected. */
export function safeNotificationPath(path: string): string {
  return isValidNotificationPath(path) ? path : "notifications";
}

export const NOTIFICATION_TITLE_MAX = 200;
export const NOTIFICATION_BODY_MAX = 500;
export const NOTIFICATIONS_PAGE_SIZE = 20;
/** Items shown in the shell's bell dropdown. */
export const NOTIFICATION_BELL_ITEMS = 8;
const MAX_RECIPIENTS = 5000;

const notifySchema = z.object({
  recipientIds: z.array(z.string().min(1).max(64)).max(MAX_RECIPIENTS),
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string().trim().min(1).max(NOTIFICATION_TITLE_MAX),
  body: z.string().trim().max(NOTIFICATION_BODY_MAX).nullish(),
  path: z.string().refine(isValidNotificationPath, "Geçersiz bildirim yolu."),
  /** Team-only ("Yalnızca ekip") content: never notify GUEST members. */
  internal: z.boolean().optional(),
});

export type NotifyInput = z.input<typeof notifySchema>;

function logFailure(where: string, e: unknown) {
  console.error(`[notifications] ${where} failed:`, e);
}

/**
 * Create notifications for `recipientIds` in ctx's workspace. Drops the actor,
 * de-duplicates, and keeps only ids that are CURRENT members of the workspace.
 * Returns the number of rows created. Never throws.
 */
export async function notify(ctx: TenantContext, input: NotifyInput): Promise<number> {
  try {
    const data = parseInput(notifySchema, input);
    const wanted = [...new Set(data.recipientIds)].filter((id) => id !== ctx.userId);
    if (wanted.length === 0) return 0;
    // Lock the recipients' membership rows (FOR SHARE) and insert in the same
    // transaction: a concurrent removeMember's DELETE then waits for this
    // commit, and its notification cleanup sees (and removes) these rows.
    return await db.$transaction(async (tx) => {
      const members = await tx.$queryRaw<Array<{ userId: string }>>`
        SELECT "userId" FROM "Membership"
        WHERE "workspaceId" = ${ctx.workspaceId} AND "userId" = ANY(${wanted}::text[])
          AND (${data.internal !== true}::boolean OR role <> 'GUEST')
        FOR SHARE`;
      if (members.length === 0) return 0;
      // One batched lookup: recipients who muted this type in this workspace.
      const muted = await tx.notificationPreference.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId: { in: members.map((m) => m.userId) },
          mutedTypes: { has: data.type },
        },
        select: { userId: true },
      });
      const mutedIds = new Set(muted.map((m) => m.userId));
      const recipients = members.filter((m) => !mutedIds.has(m.userId));
      if (recipients.length === 0) return 0;
      const res = await tx.notification.createMany({
        data: recipients.map((m) => ({
          workspaceId: ctx.workspaceId,
          userId: m.userId,
          actorId: ctx.userId,
          type: data.type,
          title: data.title,
          body: data.body || null,
          path: data.path,
        })),
      });
      return res.count;
    });
  } catch (e) {
    logFailure("notify", e);
    return 0;
  }
}

// ------------------------------------------------------------ triggers ----

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

async function actorLabel(ctx: TenantContext): Promise<string> {
  const u = await db.user.findUnique({
    where: { id: ctx.userId },
    select: { name: true, email: true },
  });
  return clip(u?.name?.trim() || u?.email || "Bir üye", 80);
}

async function memberIds(ctx: TenantContext, roles?: Role[]): Promise<string[]> {
  const rows = await db.membership.findMany({
    where: { workspaceId: ctx.workspaceId, ...(roles ? { role: { in: roles } } : {}) },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Run a trigger; any failure (including lookups) is logged and swallowed. */
async function safely(where: string, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (e) {
    logFailure(where, e);
    return 0;
  }
}

/** A to-do was assigned (or reassigned) to `assigneeId`. */
export function notifyTodoAssigned(
  ctx: TenantContext,
  item: { id: string; title: string; assigneeId: string; internal?: boolean },
): Promise<number> {
  return safely("notifyTodoAssigned", async () => {
    if (item.assigneeId === ctx.userId) return 0;
    const actor = await actorLabel(ctx);
    return notify(ctx, {
      recipientIds: [item.assigneeId],
      type: "TODO_ASSIGNED",
      title: `${actor} size bir görev atadı`,
      body: clip(item.title, NOTIFICATION_BODY_MAX),
      path: "todos",
      internal: item.internal,
    });
  });
}

/** A new message-board post: every other member. */
export function notifyPostCreated(
  ctx: TenantContext,
  post: { id: string; title: string; internal?: boolean },
): Promise<number> {
  return safely("notifyPostCreated", async () => {
    const [actor, ids] = await Promise.all([actorLabel(ctx), memberIds(ctx)]);
    return notify(ctx, {
      recipientIds: ids,
      type: "POST_CREATED",
      title: `${actor} yeni bir mesaj paylaştı`,
      body: clip(post.title, NOTIFICATION_BODY_MAX),
      path: `messages/${post.id}`,
      internal: post.internal,
    });
  });
}

/** A new comment: the post author plus everyone who commented on the post before. */
export function notifyPostComment(
  ctx: TenantContext,
  comment: { id: string; postId: string; postTitle: string; postAuthorId: string; body: string; internal?: boolean },
): Promise<number> {
  return safely("notifyPostComment", async () => {
    const [actor, earlier] = await Promise.all([
      actorLabel(ctx),
      db.comment.findMany({
        where: { workspaceId: ctx.workspaceId, postId: comment.postId, id: { not: comment.id } },
        select: { authorId: true },
        distinct: ["authorId"],
      }),
    ]);
    return notify(ctx, {
      recipientIds: [comment.postAuthorId, ...earlier.map((c) => c.authorId)],
      type: "POST_COMMENT",
      title: clip(`${actor} “${clip(comment.postTitle, 80)}” mesajına yorum yaptı`, NOTIFICATION_TITLE_MAX),
      body: clip(comment.body, 200),
      path: `messages/${comment.postId}`,
      internal: comment.internal,
    });
  });
}

/** A new calendar event: every other member. */
export function notifyEventCreated(
  ctx: TenantContext,
  event: { id: string; title: string; startsAt: Date; internal?: boolean },
  /** Members who get a more specific notification (e.g. EVENT_INVITE) instead. */
  excludeIds: string[] = [],
): Promise<number> {
  return safely("notifyEventCreated", async () => {
    const [actor, all] = await Promise.all([actorLabel(ctx), memberIds(ctx)]);
    const skip = new Set(excludeIds);
    const ids = all.filter((id) => !skip.has(id));
    const dayKey = istanbulDayKey(event.startsAt);
    return notify(ctx, {
      recipientIds: ids,
      type: "EVENT_CREATED",
      title: `${actor} yeni bir etkinlik ekledi`,
      body: clip(event.title, NOTIFICATION_BODY_MAX),
      path: `calendar?month=${dayKey.slice(0, 7)}#agenda-${dayKey}`,
      internal: event.internal,
    });
  });
}

/** Members were invited to an event: only they are notified. */
export function notifyEventInvited(
  ctx: TenantContext,
  event: { id: string; title: string; startsAt: Date; internal?: boolean },
  inviteeIds: string[],
): Promise<number> {
  return safely("notifyEventInvited", async () => {
    const actor = await actorLabel(ctx);
    return notify(ctx, {
      recipientIds: inviteeIds,
      type: "EVENT_INVITE",
      title: `${actor} sizi bir etkinliğe davet etti`,
      body: clip(event.title, NOTIFICATION_BODY_MAX),
      path: `calendar/${event.id}`,
      internal: event.internal,
    });
  });
}

/** ctx.userId just joined via an invitation: the workspace OWNERs and ADMINs. */
export function notifyMemberJoined(ctx: TenantContext): Promise<number> {
  return safely("notifyMemberJoined", async () => {
    const [actor, ids] = await Promise.all([actorLabel(ctx), memberIds(ctx, ["OWNER", "ADMIN"])]);
    return notify(ctx, {
      recipientIds: ids,
      type: "MEMBER_JOINED",
      title: `${actor} çalışma alanına katıldı`,
      body: null,
      path: "settings",
    });
  });
}

// ------------------------------------------------------------- reading ----

export type NotificationActor = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

export type NotificationDTO = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  /** Workspace-relative, validated (falls back to "notifications"). */
  path: string;
  readAt: Date | null;
  createdAt: Date;
  actor: NotificationActor | null;
};

const idSchema = z.string().trim().min(1, "Bildirim bulunamadı.").max(64, "Bildirim bulunamadı.");

const cursorSchema = z.object({ t: z.string().datetime(), i: z.string().min(1).max(64) });

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.createdAt.toISOString(), i: row.id })).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const invalid = () =>
    new ServiceError("VALIDATION", "Geçersiz sayfa imleci.", { cursor: ["Geçersiz sayfa imleci."] });
  if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  return { createdAt: new Date(parsed.data.t), id: parsed.data.i };
}

const listSchema = z.object({
  cursor: z.string().max(256).nullish(),
  unreadOnly: z.boolean().optional(),
  take: z.number().int().min(1).max(50).optional(),
});

function scope(ctx: TenantContext): Prisma.NotificationWhereInput {
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

/** Types that only ever concern the team: a guest never sees them, even from before a demotion. */
const GUEST_HIDDEN_TYPES = ["CHAT_DM", "CHECKIN", "MEMBER_JOINED"];

type PathKind = "post" | "todo" | "doc" | "event";

/** Which team-visibility-bearing subject a notification path points at (null = none). */
function pathTarget(path: string): { kind: PathKind; id: string } | null {
  const clean = path.split(/[?#]/)[0];
  const rules: Array<[RegExp, PathKind]> = [
    [/^messages\/([A-Za-z0-9_-]+)$/, "post"],
    [/^todos\/([A-Za-z0-9_-]+)$/, "todo"],
    [/^files\/docs\/([A-Za-z0-9_-]+)$/, "doc"],
    [/^calendar\/([A-Za-z0-9_-]+)$/, "event"],
  ];
  for (const [re, kind] of rules) {
    const m = clean.match(re);
    if (m) return { kind, id: m[1] };
  }
  return null;
}

/**
 * The caller's notifications as the caller may see them. A GUEST additionally
 * loses team-only types and every notification whose target (post, to-do,
 * document, event) is team-only right now, so an item flipped to internal
 * after the notification went out disappears from the bell too.
 */
async function visibleScope(ctx: TenantContext): Promise<Prisma.NotificationWhereInput> {
  const base = scope(ctx);
  if (!isGuest(ctx.role)) return base;
  const rows = await db.notification.findMany({
    where: { ...base, type: { notIn: GUEST_HIDDEN_TYPES } },
    select: { path: true },
    distinct: ["path"],
  });
  const targets = rows.map((r) => ({ path: r.path, t: pathTarget(r.path) })).filter((r) => r.t !== null);
  const idsOf = (kind: PathKind) => targets.filter((r) => r.t!.kind === kind).map((r) => r.t!.id);
  const workspaceId = ctx.workspaceId;
  const [postIds, todoIds, docIds, eventIds] = [idsOf("post"), idsOf("todo"), idsOf("doc"), idsOf("event")];
  const [posts, todos, docs, events] = await Promise.all([
    postIds.length ? db.post.findMany({ where: { workspaceId, id: { in: postIds }, internal: false }, select: { id: true } }) : [],
    todoIds.length
      ? db.todoItem.findMany({ where: { workspaceId, id: { in: todoIds }, list: { internal: false } }, select: { id: true } })
      : [],
    docIds.length
      ? db.document.findMany({
          where: { workspaceId, id: { in: docIds }, internal: false, OR: [{ folderId: null }, { folder: { internal: false } }] },
          select: { id: true },
        })
      : [],
    eventIds.length ? db.event.findMany({ where: { workspaceId, id: { in: eventIds }, internal: false }, select: { id: true } }) : [],
  ]);
  // Anything not found as visible (internal, deleted or gone) is hidden.
  const visible: Record<PathKind, Set<string>> = {
    post: new Set(posts.map((r) => r.id)),
    todo: new Set(todos.map((r) => r.id)),
    doc: new Set(docs.map((r) => r.id)),
    event: new Set(events.map((r) => r.id)),
  };
  const hidden = targets.filter((r) => !visible[r.t!.kind].has(r.t!.id)).map((r) => r.path);
  return {
    ...base,
    type: { notIn: GUEST_HIDDEN_TYPES },
    ...(hidden.length ? { path: { notIn: hidden } } : {}),
  };
}

/** The caller's own notifications in this workspace, newest first (keyset pagination). */
export async function listNotifications(
  ctx: TenantContext,
  input: { cursor?: string | null; unreadOnly?: boolean; take?: number } = {},
): Promise<{ items: NotificationDTO[]; hasMore: boolean; nextCursor: string | null }> {
  const opts = parseInput(listSchema, input);
  const take = opts.take ?? NOTIFICATIONS_PAGE_SIZE;
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const where: Prisma.NotificationWhereInput = {
    ...(await visibleScope(ctx)),
    ...(opts.unreadOnly ? { readAt: null } : {}),
    ...(after
      ? {
          OR: [
            { createdAt: { lt: after.createdAt } },
            { createdAt: after.createdAt, id: { lt: after.id } },
          ],
        }
      : {}),
  };
  const rows = await db.notification.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: { actor: { select: { id: true, name: true, email: true, image: true } } },
  });
  const hasMore = rows.length > take;
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      path: safeNotificationPath(r.path),
      readAt: r.readAt,
      createdAt: r.createdAt,
      actor: r.actor,
    })),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

export async function unreadCount(ctx: TenantContext): Promise<number> {
  return db.notification.count({ where: { ...(await visibleScope(ctx)), readAt: null } });
}

/**
 * Mark one of the caller's notifications read. NOT_FOUND for ids that belong
 * to another user or workspace. Returns the (validated) path to open.
 */
export async function markRead(ctx: TenantContext, id: string): Promise<{ id: string; path: string }> {
  const notificationId = parseInput(idSchema, id);
  const row = await db.notification.findFirst({
    where: { ...(await visibleScope(ctx)), id: notificationId },
    select: { id: true, path: true, readAt: true },
  });
  if (!row) throw notFound("Bildirim bulunamadı.");
  if (!row.readAt) {
    await db.notification.updateMany({
      where: { ...scope(ctx), id: row.id, readAt: null },
      data: { readAt: new Date() },
    });
  }
  return { id: row.id, path: safeNotificationPath(row.path) };
}

/** Mark all of the caller's unread notifications in this workspace read. */
export async function markAllRead(ctx: TenantContext): Promise<number> {
  const res = await db.notification.updateMany({
    where: { ...scope(ctx), readAt: null },
    data: { readAt: new Date() },
  });
  return res.count;
}

// ------------------------------------------------------ direct messages ----

/**
 * A direct message arrived for `peerId`. One unread notification per
 * conversation is enough: while it is unread, further messages add nothing.
 */
export async function notifyChatDm(ctx: TenantContext, peerId: string, text: string): Promise<number> {
  return safely("notifyChatDm", async () => {
    // The link opens the conversation with the SENDER (from the recipient's side).
    const path = `chat?with=${ctx.userId}`;
    const open = await db.notification.findFirst({
      where: { workspaceId: ctx.workspaceId, userId: peerId, type: "CHAT_DM", path, readAt: null },
      select: { id: true },
    });
    if (open) return 0;
    const label = await actorLabel(ctx);
    return notify(ctx, {
      recipientIds: [peerId],
      type: "CHAT_DM",
      title: `${label} size mesaj gönderdi`,
      body: clip(text || "📷 Fotoğraf", 500),
      path,
    });
  });
}

/** Opening a conversation reads its notification. */
export async function markDmRead(ctx: TenantContext, peerId: string): Promise<void> {
  await db.notification.updateMany({
    where: {
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      type: "CHAT_DM",
      path: `chat?with=${peerId}`,
      readAt: null,
    },
    data: { readAt: new Date() },
  });
}
