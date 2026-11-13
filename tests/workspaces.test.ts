import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { createLocalDriver, generateStorageKey, type StorageDriver } from "@/lib/storage";
import { ServiceError } from "@/server/errors";
import { acceptLocalUpload, createPendingUpload } from "@/server/files";
import {
  acceptInvitation,
  changeMemberRole,
  createInvitation,
  createWorkspace,
  deleteWorkspace,
  getInvitationByToken,
  hashInviteToken,
  leaveWorkspace,
  listMembers,
  removeMember,
  revokeInvitation,
} from "@/server/workspaces";

import {
  addMember,
  cleanup,
  createMember,
  createTestUser,
  createTestWorkspace,
  trackOutbox,
  trackWorkspace,
  uniqueSuffix,
} from "./helpers";

afterAll(async () => {
  await cleanup();
});

async function expectServiceError(p: Promise<unknown>, code: ServiceError["code"]) {
  await expect(p).rejects.toBeInstanceOf(ServiceError);
  await p.catch((e: ServiceError) => expect(e.code).toBe(code));
}

describe("createWorkspace", () => {
  it("creates the workspace with the creator as OWNER", async () => {
    const user = await createTestUser();
    const slug = `ws-${uniqueSuffix()}`;
    const ws = await createWorkspace({ userId: user.id }, { name: "Atölye", slug });
    trackWorkspace(ws.id);
    const m = await db.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } },
    });
    expect(m?.role).toBe("OWNER");
  });

  it("rejects reserved and duplicate slugs", async () => {
    const user = await createTestUser();
    await expectServiceError(createWorkspace({ userId: user.id }, { name: "X Ajans", slug: "app" }), "VALIDATION");
    const { workspace } = await createTestWorkspace(user.id);
    await expectServiceError(
      createWorkspace({ userId: user.id }, { name: "Kopya", slug: workspace.slug }),
      "CONFLICT",
    );
  });
});

describe("invitations", () => {
  it("happy path: invitee with matching email joins with the invited role", async () => {
    const owner = await createTestUser();
    const { workspace, ctx } = await createTestWorkspace(owner.id);
    const invitee = await createTestUser();

    const { token, invitation } = await createInvitation(ctx, {
      email: invitee.email.toUpperCase(),
      role: "ADMIN",
    });
    expect(invitation.email).toBe(invitee.email);
    // Only the hash is stored.
    expect(invitation.tokenHash).toBe(hashInviteToken(token));
    expect(invitation.tokenHash).not.toContain(token);
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url

    const preview = await getInvitationByToken(token);
    expect(preview?.status).toBe("valid");
    expect(preview?.workspace.id).toBe(workspace.id);

    const res = await acceptInvitation({ userId: invitee.id, email: invitee.email }, token);
    expect(res.alreadyMember).toBe(false);
    expect(res.membership.role).toBe("ADMIN");
    expect(res.workspace.slug).toBe(workspace.slug);

    const stored = await db.invitation.findUnique({ where: { id: invitation.id } });
    expect(stored?.acceptedAt).not.toBeNull();
  });

  it("rejects a signed-in user whose email does not match", async () => {
    const owner = await createTestUser();
    const { workspace, ctx } = await createTestWorkspace(owner.id);
    const intended = await createTestUser();
    const other = await createTestUser();
    const { token } = await createInvitation(ctx, { email: intended.email, role: "MEMBER" });

    await expectServiceError(
      acceptInvitation({ userId: other.id, email: other.email }, token),
      "FORBIDDEN",
    );
    const m = await db.membership.findUnique({
      where: { userId_workspaceId: { userId: other.id, workspaceId: workspace.id } },
    });
    expect(m).toBeNull();
    // Invitation is still usable by the right person.
    expect((await getInvitationByToken(token))?.status).toBe("valid");
  });

  it("is single-use, and idempotent for the user who already joined", async () => {
    const owner = await createTestUser();
    const { workspace, ctx } = await createTestWorkspace(owner.id);
    const invitee = await createTestUser();
    const { token } = await createInvitation(ctx, { email: invitee.email, role: "MEMBER" });

    await acceptInvitation({ userId: invitee.id, email: invitee.email }, token);
    const again = await acceptInvitation({ userId: invitee.id, email: invitee.email }, token);
    expect(again.alreadyMember).toBe(true);
    expect(await db.membership.count({ where: { workspaceId: workspace.id, userId: invitee.id } })).toBe(1);

    // Someone else with the same email (e.g. after the first left) cannot reuse it.
    await leaveWorkspace({ userId: invitee.id, workspaceId: workspace.id, role: "MEMBER" });
    await expectServiceError(
      acceptInvitation({ userId: invitee.id, email: invitee.email }, token),
      "CONFLICT",
    );
  });

  it("concurrent accepts create exactly one membership", async () => {
    const owner = await createTestUser();
    const { workspace, ctx } = await createTestWorkspace(owner.id);
    const invitee = await createTestUser();
    const { token } = await createInvitation(ctx, { email: invitee.email, role: "MEMBER" });
    const results = await Promise.allSettled([
      acceptInvitation({ userId: invitee.id, email: invitee.email }, token),
      acceptInvitation({ userId: invitee.id, email: invitee.email }, token),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await db.membership.count({ where: { workspaceId: workspace.id, userId: invitee.id } })).toBe(1);
  });

  it("rejects expired and revoked invitations", async () => {
    const owner = await createTestUser();
    const { ctx } = await createTestWorkspace(owner.id);
    const a = await createTestUser();
    const b = await createTestUser();

    const expired = await createInvitation(ctx, { email: a.email, role: "MEMBER" });
    await db.invitation.update({
      where: { id: expired.invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await getInvitationByToken(expired.token))?.status).toBe("expired");
    await expectServiceError(acceptInvitation({ userId: a.id, email: a.email }, expired.token), "CONFLICT");

    const revoked = await createInvitation(ctx, { email: b.email, role: "MEMBER" });
    await revokeInvitation(ctx, revoked.invitation.id);
    await expectServiceError(acceptInvitation({ userId: b.id, email: b.email }, revoked.token), "CONFLICT");
  });

  it("rejects unknown tokens", async () => {
    const u = await createTestUser();
    await expectServiceError(
      acceptInvitation({ userId: u.id, email: u.email }, "x".repeat(43)),
      "NOT_FOUND",
    );
    expect(await getInvitationByToken("x".repeat(43))).toBeNull();
  });

  it("only OWNER can invite as OWNER; MEMBER cannot invite", async () => {
    const owner = await createTestUser();
    const { workspace } = await createTestWorkspace(owner.id);
    const { ctx: adminCtx } = await createMember(workspace.id, "ADMIN");
    const { ctx: memberCtx } = await createMember(workspace.id, "MEMBER");

    await expectServiceError(
      createInvitation(adminCtx, { email: trackOutbox(`o-${uniqueSuffix()}@hestia.test`), role: "OWNER" }),
      "FORBIDDEN",
    );
    await expectServiceError(
      createInvitation(memberCtx, { email: trackOutbox(`m-${uniqueSuffix()}@hestia.test`), role: "MEMBER" }),
      "FORBIDDEN",
    );
    const ok = await createInvitation(adminCtx, { email: trackOutbox(`a-${uniqueSuffix()}@hestia.test`), role: "ADMIN" });
    expect(ok.invitation.role).toBe("ADMIN");
  });
});

describe("owner protection", () => {
  it("the last OWNER cannot be demoted, removed or leave", async () => {
    const owner = await createTestUser();
    const { workspace, ctx } = await createTestWorkspace(owner.id);
    const own = await db.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    });

    await expectServiceError(changeMemberRole(ctx, own.id, "ADMIN"), "CONFLICT");
    await expectServiceError(removeMember(ctx, own.id), "CONFLICT");
    await expectServiceError(leaveWorkspace(ctx), "CONFLICT");

    // With a second owner, demotion works.
    const second = await createTestUser();
    await addMember(workspace.id, second.id, "OWNER");
    const demoted = await changeMemberRole(ctx, own.id, "ADMIN");
    expect(demoted.role).toBe("ADMIN");
    const owners = (await listMembers({ ...ctx, role: "ADMIN" })).filter((m) => m.role === "OWNER");
    expect(owners).toHaveLength(1);
  });

  it("ADMIN cannot modify or remove an OWNER, nor grant OWNER", async () => {
    const owner = await createTestUser();
    const { workspace } = await createTestWorkspace(owner.id);
    const { ctx: adminCtx } = await createMember(workspace.id, "ADMIN");
    const { ctx: memberCtx } = await createMember(workspace.id, "MEMBER");
    const ownerM = await db.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    });
    const memberM = await db.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: memberCtx.userId, workspaceId: workspace.id } },
    });

    await expectServiceError(changeMemberRole(adminCtx, ownerM.id, "MEMBER"), "FORBIDDEN");
    await expectServiceError(removeMember(adminCtx, ownerM.id), "FORBIDDEN");
    await expectServiceError(changeMemberRole(adminCtx, memberM.id, "OWNER"), "FORBIDDEN");
    // MEMBER cannot manage anyone.
    await expectServiceError(removeMember(memberCtx, ownerM.id), "FORBIDDEN");

    const promoted = await changeMemberRole(adminCtx, memberM.id, "ADMIN");
    expect(promoted.role).toBe("ADMIN");
  });

  it("a member can leave", async () => {
    const owner = await createTestUser();
    const { workspace } = await createTestWorkspace(owner.id);
    const { ctx } = await createMember(workspace.id, "MEMBER");
    await leaveWorkspace(ctx);
    expect(await db.membership.count({ where: { workspaceId: workspace.id, userId: ctx.userId } })).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("a ctx for workspace A cannot touch memberships or invitations of workspace B", async () => {
    const ownerA = await createTestUser();
    const ownerB = await createTestUser();
    const { ctx: ctxA } = await createTestWorkspace(ownerA.id);
    const { workspace: wsB, ctx: ctxB } = await createTestWorkspace(ownerB.id);
    const { user: memberB } = await createMember(wsB.id, "MEMBER");
    const memberBM = await db.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: memberB.id, workspaceId: wsB.id } },
    });
    const inviteB = await createInvitation(ctxB, { email: trackOutbox(`x-${uniqueSuffix()}@hestia.test`), role: "MEMBER" });

    await expectServiceError(changeMemberRole(ctxA, memberBM.id, "ADMIN"), "NOT_FOUND");
    await expectServiceError(removeMember(ctxA, memberBM.id), "NOT_FOUND");
    await expectServiceError(revokeInvitation(ctxA, inviteB.invitation.id), "NOT_FOUND");

    const stillThere = await db.membership.findUnique({ where: { id: memberBM.id } });
    expect(stillThere?.role).toBe("MEMBER");
    expect(
      (await listMembers(ctxA)).some((m) => m.user.id === memberB.id),
    ).toBe(false);
  });

  it("a forged ctx (non-member claiming OWNER of B) is rejected", async () => {
    const ownerB = await createTestUser();
    const outsider = await createTestUser();
    const { workspace: wsB } = await createTestWorkspace(ownerB.id);
    const { user: memberB } = await createMember(wsB.id, "MEMBER");
    const memberBM = await db.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: memberB.id, workspaceId: wsB.id } },
    });
    const forged = { userId: outsider.id, workspaceId: wsB.id, role: "OWNER" as const };

    await expectServiceError(removeMember(forged, memberBM.id), "NOT_FOUND");
    await expectServiceError(changeMemberRole(forged, memberBM.id, "ADMIN"), "NOT_FOUND");
    await expectServiceError(
      createInvitation(forged, { email: trackOutbox(`f-${uniqueSuffix()}@hestia.test`), role: "OWNER" }),
      "NOT_FOUND",
    );
    expect(await db.membership.findUnique({ where: { id: memberBM.id } })).not.toBeNull();
  });
});

describe("invitations outlive the inviter's role (regression)", () => {
  async function membershipOf(userId: string, workspaceId: string) {
    return db.membership.findUniqueOrThrow({ where: { userId_workspaceId: { userId, workspaceId } } });
  }

  it("a demoted ex-OWNER's OWNER invite can no longer be accepted", async () => {
    const a = await createTestUser();
    const { workspace, ctx: aCtx } = await createTestWorkspace(a.id);
    const b = await createTestUser();
    const bCtx = await addMember(workspace.id, b.id, "OWNER");
    const alt = await createTestUser();

    const { token, invitation } = await createInvitation(aCtx, { email: alt.email, role: "OWNER" });
    await changeMemberRole(bCtx, (await membershipOf(a.id, workspace.id)).id, "MEMBER");

    const row = await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.revokedAt).not.toBeNull();
    await expectServiceError(acceptInvitation({ userId: alt.id, email: alt.email }, token), "CONFLICT");
    expect(
      await db.membership.findUnique({ where: { userId_workspaceId: { userId: alt.id, workspaceId: workspace.id } } }),
    ).toBeNull();
  });

  it("OWNER -> ADMIN demotion revokes only OWNER-role invites", async () => {
    const a = await createTestUser();
    const { workspace, ctx: aCtx } = await createTestWorkspace(a.id);
    const b = await createTestUser();
    const bCtx = await addMember(workspace.id, b.id, "OWNER");
    const o = await createInvitation(aCtx, { email: trackOutbox(`o-${uniqueSuffix()}@hestia.test`), role: "OWNER" });
    const m = await createInvitation(aCtx, { email: trackOutbox(`m-${uniqueSuffix()}@hestia.test`), role: "MEMBER" });

    await changeMemberRole(bCtx, (await membershipOf(a.id, workspace.id)).id, "ADMIN");
    expect((await db.invitation.findUniqueOrThrow({ where: { id: o.invitation.id } })).revokedAt).not.toBeNull();
    expect((await db.invitation.findUniqueOrThrow({ where: { id: m.invitation.id } })).revokedAt).toBeNull();
  });

  it("a removed ADMIN's invites are revoked", async () => {
    const owner = await createTestUser();
    const { workspace, ctx } = await createTestWorkspace(owner.id);
    const { user: admin, ctx: adminCtx } = await createMember(workspace.id, "ADMIN");
    const alt = await createTestUser();
    const { token } = await createInvitation(adminCtx, { email: alt.email, role: "ADMIN" });

    await removeMember(ctx, (await membershipOf(admin.id, workspace.id)).id);
    await expectServiceError(acceptInvitation({ userId: alt.id, email: alt.email }, token), "CONFLICT");
  });

  it("acceptInvitation re-checks the inviter even if the invite was never revoked", async () => {
    const owner = await createTestUser();
    const { workspace } = await createTestWorkspace(owner.id);
    const { user: admin, ctx: adminCtx } = await createMember(workspace.id, "ADMIN");
    const alt = await createTestUser();
    const { token } = await createInvitation(adminCtx, { email: alt.email, role: "ADMIN" });
    // Demoted out-of-band (no service call), so nothing revoked the invite.
    await db.membership.update({
      where: { userId_workspaceId: { userId: admin.id, workspaceId: workspace.id } },
      data: { role: "MEMBER" },
    });
    await expectServiceError(acceptInvitation({ userId: alt.id, email: alt.email }, token), "CONFLICT");
  });
});

describe("deleteWorkspace", () => {
  function fakeStorage(): StorageDriver & { deleted: string[]; swept: string[] } {
    const deleted: string[] = [];
    const swept: string[] = [];
    return {
      name: "local",
      deleted,
      swept,
      async delete(key: string) {
        deleted.push(key);
      },
      async deleteWorkspaceObjects(workspaceId: string) {
        swept.push(workspaceId);
        return 0;
      },
    } as unknown as StorageDriver & { deleted: string[]; swept: string[] };
  }

  async function seedFile(workspaceId: string, userId: string, name: string) {
    const storageKey = generateStorageKey(workspaceId, name);
    await db.file.create({
      data: { workspaceId, uploadedById: userId, name, mimeType: "text/plain", size: 1, storageKey },
    });
    return storageKey;
  }

  it("non-owners cannot delete, even admins", async () => {
    const owner = await createTestUser();
    const { workspace } = await createTestWorkspace(owner.id);
    const { ctx: adminCtx } = await createMember(workspace.id, "ADMIN");
    const { ctx: memberCtx } = await createMember(workspace.id, "MEMBER");
    const storage = fakeStorage();
    await expectServiceError(deleteWorkspace(adminCtx, { confirmSlug: workspace.slug }, storage), "FORBIDDEN");
    await expectServiceError(deleteWorkspace(memberCtx, { confirmSlug: workspace.slug }, storage), "FORBIDDEN");
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
  });

  it("rejects a stale ctx claiming OWNER when the DB role is lower", async () => {
    const owner = await createTestUser();
    const { workspace } = await createTestWorkspace(owner.id);
    const { user } = await createMember(workspace.id, "MEMBER");
    const forged = { userId: user.id, workspaceId: workspace.id, role: "OWNER" as const };
    await expectServiceError(deleteWorkspace(forged, { confirmSlug: workspace.slug }, fakeStorage()), "FORBIDDEN");
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
  });

  it("rejects a wrong or missing confirmation", async () => {
    const owner = await createTestUser();
    const { workspace, ctx } = await createTestWorkspace(owner.id);
    const storage = fakeStorage();
    await expectServiceError(deleteWorkspace(ctx, { confirmSlug: "baska-bir-adres" }, storage), "VALIDATION");
    await expectServiceError(deleteWorkspace(ctx, {}, storage), "VALIDATION");
    await expectServiceError(deleteWorkspace(ctx, { confirmSlug: "" }, storage), "VALIDATION");
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
    expect(storage.deleted).toEqual([]);
  });

  it("removes rows and storage objects and leaves other workspaces untouched", async () => {
    const owner = await createTestUser();
    const { workspace: a, ctx: ctxA } = await createTestWorkspace(owner.id);
    const { workspace: b } = await createTestWorkspace(owner.id);
    const keyA = await seedFile(a.id, owner.id, "a.txt");
    const keyB = await seedFile(b.id, owner.id, "b.txt");
    const pendingKey = generateStorageKey(a.id, "pending.txt");
    await db.uploadKey.create({ data: { storageKey: pendingKey, workspaceId: a.id } });
    await db.invitation.create({
      data: {
        workspaceId: a.id,
        email: "x@hestia.test",
        role: "MEMBER",
        tokenHash: hashInviteToken(`t-${uniqueSuffix()}`),
        invitedById: owner.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const storage = fakeStorage();
    const result = await deleteWorkspace(ctxA, { confirmSlug: a.slug.toUpperCase() }, storage);

    expect(result.deletedObjects).toBe(2);
    expect([...storage.deleted].sort()).toEqual([keyA, pendingKey].sort());
    expect(await db.workspace.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await db.file.count({ where: { workspaceId: a.id } })).toBe(0);
    expect(await db.membership.count({ where: { workspaceId: a.id } })).toBe(0);
    expect(await db.invitation.count({ where: { workspaceId: a.id } })).toBe(0);
    expect(await db.uploadKey.count({ where: { workspaceId: a.id } })).toBe(0);

    expect(await db.workspace.findUnique({ where: { id: b.id } })).not.toBeNull();
    expect(await db.file.count({ where: { workspaceId: b.id, storageKey: keyB } })).toBe(1);
    expect(await db.membership.count({ where: { workspaceId: b.id } })).toBe(1);
    expect(storage.deleted).not.toContain(keyB);
    expect(storage.swept).toEqual([a.id]);
    expect(await db.user.findUnique({ where: { id: owner.id } })).not.toBeNull();
  });

  it("also removes bytes of an upload that was PUT but never completed (no row points at it)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hestia-delws-"));
    try {
      const storage = createLocalDriver(root);
      const owner = await createTestUser();
      const { workspace: a, ctx: ctxA } = await createTestWorkspace(owner.id);
      const { workspace: b, ctx: ctxB } = await createTestWorkspace(owner.id);
      const { ctx: member } = await createMember(a.id, "MEMBER");
      const bytes = new TextEncoder().encode("yarım kalan yükleme");
      const put = async (ctx: typeof ctxA) => {
        const pending = await createPendingUpload(
          ctx,
          { name: "yarim.txt", size: bytes.byteLength, type: "text/plain", folderId: null },
          storage,
        );
        expect(await acceptLocalUpload(ctx.userId, pending.token, bytes, bytes.byteLength, storage)).toEqual({
          ok: true,
          size: bytes.byteLength,
        });
      };
      await put(member);
      await put(ctxB);
      const keysUnder = (ws: string) => readdir(path.join(root, ws)).catch(() => [] as string[]);
      expect(await keysUnder(a.id)).toHaveLength(1);
      expect(await db.uploadKey.count({ where: { workspaceId: a.id } })).toBe(0); // never completed

      await deleteWorkspace(ctxA, { confirmSlug: a.slug }, storage);
      expect(await keysUnder(a.id)).toHaveLength(0);
      // Other workspaces' objects stay.
      expect(await keysUnder(b.id)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the local prefix delete refuses ids that could escape the storage root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hestia-delws-"));
    try {
      const storage = createLocalDriver(root);
      for (const bad of ["", "..", "../x", "a/b", "a\b", ".", "x.y"]) {
        await expect(storage.deleteWorkspaceObjects(bad), bad).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("an owner of workspace A cannot delete workspace B by passing B's slug", async () => {
    const ownerA = await createTestUser();
    const ownerB = await createTestUser();
    const { ctx: ctxA } = await createTestWorkspace(ownerA.id);
    const { workspace: b } = await createTestWorkspace(ownerB.id);
    await expectServiceError(deleteWorkspace(ctxA, { confirmSlug: b.slug }, fakeStorage()), "VALIDATION");
    expect(await db.workspace.findUnique({ where: { id: b.id } })).not.toBeNull();
  });

  it("still deletes when a storage delete fails", async () => {
    const owner = await createTestUser();
    const { workspace, ctx } = await createTestWorkspace(owner.id);
    await seedFile(workspace.id, owner.id, "z.txt");
    const failing = {
      name: "local",
      async delete() {
        throw new Error("boom");
      },
    } as unknown as StorageDriver;
    await deleteWorkspace(ctx, { confirmSlug: workspace.slug }, failing);
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
  });
});
