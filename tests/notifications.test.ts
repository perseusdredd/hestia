import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { createEvent } from "@/server/calendar";
import { ServiceError } from "@/server/errors";
import { createComment, createPost } from "@/server/messages";
import {
  isValidNotificationPath,
  listNotifications,
  markAllRead,
  markRead,
  notify,
  safeNotificationPath,
  unreadCount,
} from "@/server/notifications";
import { getMutedTypes, setMutedTypes } from "@/server/notification-preferences";
import { createTodoItem, createTodoList, updateTodoItem } from "@/server/todos";
import { acceptInvitation, createInvitation, removeMember } from "@/server/workspaces";

import { addMember, cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

afterAll(async () => {
  await cleanup();
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e.code;
    throw e;
  }
  return "OK";
}

const rowsFor = (workspaceId: string, userId?: string) =>
  db.notification.findMany({
    where: { workspaceId, ...(userId ? { userId } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

describe("notifications service", () => {
  let owner: TenantContext;
  let admin: TenantContext;
  let alice: TenantContext;
  let bob: TenantContext;
  let otherOwner: TenantContext;
  let outsiderId: string;

  beforeAll(async () => {
    const o = await createTestUser();
    owner = (await createTestWorkspace(o.id)).ctx;
    admin = (await createMember(owner.workspaceId, "ADMIN")).ctx;
    alice = (await createMember(owner.workspaceId)).ctx;
    bob = (await createMember(owner.workspaceId)).ctx;
    const other = await createTestUser();
    otherOwner = (await createTestWorkspace(other.id)).ctx;
    outsiderId = other.id;
  });

  beforeEach(async () => {
    await db.notification.deleteMany({
      where: { workspaceId: { in: [owner.workspaceId, otherOwner.workspaceId] } },
    });
  });

  const base = { type: "POST_CREATED" as const, title: "Başlık", path: "messages/abc" };

  describe("notify()", () => {
    it("drops the actor, de-duplicates and keeps only current members", async () => {
      const n = await notify(alice, {
        ...base,
        recipientIds: [alice.userId, bob.userId, bob.userId, owner.userId, outsiderId, "nope"],
      });
      expect(n).toBe(2);
      const rows = await rowsFor(owner.workspaceId);
      expect(rows.map((r) => r.userId).sort()).toEqual([bob.userId, owner.userId].sort());
      expect(rows.every((r) => r.actorId === alice.userId && r.workspaceId === owner.workspaceId)).toBe(true);
      // The outsider (a member of another workspace) got nothing anywhere.
      expect(await db.notification.count({ where: { userId: outsiderId } })).toBe(0);
    });

    it("never creates rows for non-members, even when they are the only recipients", async () => {
      expect(await notify(owner, { ...base, recipientIds: [outsiderId] })).toBe(0);
      expect(await notify(owner, { ...base, recipientIds: [owner.userId] })).toBe(0);
      expect(await notify(owner, { ...base, recipientIds: [] })).toBe(0);
      expect(await rowsFor(owner.workspaceId)).toHaveLength(0);
    });

    it("rejects unsafe paths without throwing (logged, nothing stored)", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        for (const path of [
          "",
          "/w/other/messages",
          "https://evil.example",
          "javascript:alert(1)",
          "//evil.example",
          "messages/../../admin",
          "messages/..",
          "messages//x",
          "Messages",
          "messages/a b",
          "messages\\x",
          `messages/${"x".repeat(400)}`,
        ]) {
          expect(await notify(owner, { ...base, path, recipientIds: [alice.userId] })).toBe(0);
        }
        expect(await rowsFor(owner.workspaceId)).toHaveLength(0);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("path pattern accepts the paths the app produces", () => {
      for (const p of [
        "todos",
        "settings",
        "notifications",
        "messages/cmabc123",
        "calendar?month=2026-11#agenda-2026-11-12",
        "files/ck_9-x",
      ]) {
        expect(isValidNotificationPath(p)).toBe(true);
      }
      expect(isValidNotificationPath("../x")).toBe(false);
      expect(isValidNotificationPath("a.b")).toBe(false);
      expect(safeNotificationPath("https://evil.example")).toBe("notifications");
    });

    it("does not throw on a bad type or oversized title", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          notify(owner, { ...base, type: "HACK" as never, recipientIds: [alice.userId] }),
        ).resolves.toBe(0);
        await expect(
          notify(owner, { ...base, title: "x".repeat(1000), recipientIds: [alice.userId] }),
        ).resolves.toBe(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("reading and marking", () => {
    it("lists only the caller's own rows in this workspace", async () => {
      await notify(owner, { ...base, title: "Alice'e", recipientIds: [alice.userId] });
      await notify(owner, { ...base, title: "Bob'a", recipientIds: [bob.userId] });
      // alice is not a member of the other workspace: nothing is stored there.
      await notify(otherOwner, { ...base, title: "B alanı", recipientIds: [alice.userId] });

      const a = await listNotifications(alice);
      expect(a.items.map((i) => i.title)).toEqual(["Alice'e"]);
      expect(a.items[0].actor?.id).toBe(owner.userId);
      expect(await unreadCount(alice)).toBe(1);
      expect((await listNotifications(bob)).items.map((i) => i.title)).toEqual(["Bob'a"]);
      expect((await listNotifications(otherOwner)).items).toHaveLength(0);
    });

    it("workspace A's ctx cannot list or mark workspace B's rows, even with valid ids", async () => {
      const bMember = await createMember(otherOwner.workspaceId);
      await notify(otherOwner, { ...base, recipientIds: [bMember.user.id] });
      const [bRow] = await rowsFor(otherOwner.workspaceId, bMember.user.id);
      expect(bRow).toBeTruthy();

      // Same user, forged ctx pointing at workspace A: sees and touches nothing.
      const forged: TenantContext = { ...owner, userId: bMember.user.id };
      expect((await listNotifications(forged)).items).toHaveLength(0);
      expect(await unreadCount(forged)).toBe(0);
      expect(await code(markRead(owner, bRow.id))).toBe("NOT_FOUND");
      expect(await code(markRead(forged, bRow.id))).toBe("NOT_FOUND");
      expect(await markAllRead(owner)).toBe(0);
      expect(await markAllRead(forged)).toBe(0);
      expect((await db.notification.findUniqueOrThrow({ where: { id: bRow.id } })).readAt).toBeNull();
    });

    it("a member cannot mark another member's notification in the same workspace", async () => {
      await notify(owner, { ...base, recipientIds: [alice.userId, bob.userId] });
      const [aliceRow] = await rowsFor(owner.workspaceId, alice.userId);
      expect(await code(markRead(bob, aliceRow.id))).toBe("NOT_FOUND");
      // Even an ADMIN / OWNER cannot.
      expect(await code(markRead(admin, aliceRow.id))).toBe("NOT_FOUND");
      expect(await code(markRead(owner, aliceRow.id))).toBe("NOT_FOUND");
      expect(await markAllRead(bob)).toBe(1); // only bob's own row
      expect((await db.notification.findUniqueOrThrow({ where: { id: aliceRow.id } })).readAt).toBeNull();
      expect(await unreadCount(alice)).toBe(1);
    });

    it("markRead marks once, returns the path, and validates the id", async () => {
      await notify(owner, { ...base, path: "messages/p1", recipientIds: [alice.userId] });
      const [row] = await rowsFor(owner.workspaceId, alice.userId);
      expect(await markRead(alice, row.id)).toEqual({ id: row.id, path: "messages/p1" });
      const readAt = (await db.notification.findUniqueOrThrow({ where: { id: row.id } })).readAt;
      expect(readAt).not.toBeNull();
      await markRead(alice, row.id); // idempotent, keeps the first readAt
      expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).readAt).toEqual(readAt);
      expect(await unreadCount(alice)).toBe(0);
      expect(await code(markRead(alice, ""))).toBe("VALIDATION");
      expect(await code(markRead(alice, "x".repeat(65)))).toBe("VALIDATION");
    });

    it("unread filter, markAllRead and keyset pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await notify(owner, { ...base, title: `N${i}`, recipientIds: [alice.userId] });
      }
      const [oldest] = await rowsFor(owner.workspaceId, alice.userId);
      await markRead(alice, oldest.id);
      expect((await listNotifications(alice, { unreadOnly: true })).items).toHaveLength(4);

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<typeof listNotifications>> = await listNotifications(alice, {
          take: 2,
          cursor,
        });
        seen.push(...page.items.map((i) => i.title));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(["N4", "N3", "N2", "N1", "N0"]);

      expect(await markAllRead(alice)).toBe(4);
      expect(await unreadCount(alice)).toBe(0);
      expect(await code(listNotifications(alice, { cursor: "%%%" }))).toBe("VALIDATION");
      expect(await code(listNotifications(alice, { cursor: Buffer.from("{}").toString("base64url") }))).toBe(
        "VALIDATION",
      );
    });

    it("removing a member deletes their notifications in that workspace", async () => {
      const temp = await createMember(owner.workspaceId);
      await notify(owner, { ...base, recipientIds: [temp.user.id] });
      expect(await unreadCount(temp.ctx)).toBe(1);
      const m = await db.membership.findFirstOrThrow({
        where: { workspaceId: owner.workspaceId, userId: temp.user.id },
      });
      await removeMember(owner, m.id);
      expect(await db.notification.count({ where: { userId: temp.user.id } })).toBe(0);
      // And they receive nothing new.
      expect(await notify(owner, { ...base, recipientIds: [temp.user.id] })).toBe(0);
    });

    it("notify racing an in-flight removal leaves no row for the removed member", async () => {
      const temp = await createMember(owner.workspaceId);
      const m = await db.membership.findFirstOrThrow({
        where: { workspaceId: owner.workspaceId, userId: temp.user.id },
      });
      let signalDeleted!: () => void;
      const deleted = new Promise<void>((r) => (signalDeleted = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // Same statements as removeMember, but held open before COMMIT so notify
      // runs inside the window where the old membership is still visible.
      const remover = db.$transaction(
        async (tx) => {
          await tx.membership.delete({ where: { id: m.id } });
          await tx.notification.deleteMany({
            where: { workspaceId: owner.workspaceId, userId: temp.user.id },
          });
          signalDeleted();
          await gate;
        },
        { timeout: 15_000 },
      );
      await deleted;
      const notifying = notify(owner, { ...base, recipientIds: [temp.user.id, alice.userId] });
      await new Promise((r) => setTimeout(r, 300));
      release();
      await remover;
      expect(await notifying).toBe(1); // alice only
      expect(await db.notification.count({ where: { userId: temp.user.id } })).toBe(0);
    });

    it("notify and removeMember run concurrently: the removed member keeps nothing", async () => {
      const temp = await createMember(owner.workspaceId);
      const m = await db.membership.findFirstOrThrow({
        where: { workspaceId: owner.workspaceId, userId: temp.user.id },
      });
      await Promise.all([
        notify(owner, { ...base, recipientIds: [temp.user.id] }),
        removeMember(owner, m.id),
      ]);
      expect(await db.notification.count({ where: { userId: temp.user.id } })).toBe(0);
    });

    it("a re-invited former member never inherits rows from the earlier membership", async () => {
      const former = await createTestUser();
      // A leftover row for a non-member (what the removal race used to leave).
      await db.notification.create({
        data: {
          workspaceId: owner.workspaceId,
          userId: former.id,
          actorId: owner.userId,
          type: "POST_CREATED",
          title: "Eski bildirim",
          body: "Eski mesaj başlığı",
          path: "messages/old",
        },
      });
      const { token } = await createInvitation(owner, { email: former.email, role: "MEMBER" });
      await acceptInvitation({ userId: former.id, email: former.email }, token);
      const ctx: TenantContext = { userId: former.id, workspaceId: owner.workspaceId, role: "MEMBER" };
      expect((await listNotifications(ctx)).items).toHaveLength(0);
      expect(await unreadCount(ctx)).toBe(0);
      // Leave the shared workspace's member set as the later trigger tests expect.
      await db.membership.deleteMany({ where: { workspaceId: owner.workspaceId, userId: former.id } });
    });
  });

  describe("triggers", () => {
    it("to-do assigned on create and reassigned on update (assignee only, never the actor)", async () => {
      const list = await createTodoList(owner, { name: "Liste" });
      const item = await createTodoItem(owner, list.id, { title: "Raporu yaz", assigneeId: alice.userId });
      let rows = await rowsFor(owner.workspaceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: alice.userId, type: "TODO_ASSIGNED", path: "todos", body: "Raporu yaz" });

      // Updating without changing the assignee: nothing new.
      await updateTodoItem(owner, item.id, { title: "Raporu yaz", assigneeId: alice.userId });
      // Self-assignment: nothing.
      await updateTodoItem(owner, item.id, { assigneeId: owner.userId });
      expect(await rowsFor(owner.workspaceId)).toHaveLength(1);
      // Reassign to bob.
      await updateTodoItem(owner, item.id, { assigneeId: bob.userId });
      // Unassign: nothing.
      await updateTodoItem(owner, item.id, { assigneeId: "" });
      rows = await rowsFor(owner.workspaceId);
      expect(rows.map((r) => r.userId)).toEqual([alice.userId, bob.userId]);
      // Creating an unassigned item: nothing.
      await createTodoItem(owner, list.id, { title: "Boş" });
      expect(await rowsFor(owner.workspaceId)).toHaveLength(2);
    });

    it("new post notifies all other members", async () => {
      const post = await createPost(alice, { title: "Duyuru", body: "Merhaba" });
      const rows = await rowsFor(owner.workspaceId);
      expect(rows.map((r) => r.userId).sort()).toEqual([owner.userId, admin.userId, bob.userId].sort());
      expect(rows.every((r) => r.type === "POST_CREATED" && r.path === `messages/${post.id}`)).toBe(true);
      expect(rows[0].body).toBe("Duyuru");
      expect(await db.notification.count({ where: { workspaceId: otherOwner.workspaceId } })).toBe(0);
    });

    it("new comment notifies the post author and earlier commenters, not the actor", async () => {
      const post = await createPost(owner, { title: "Plan", body: "..." });
      await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });

      await createComment(alice, post.id, { body: "İlk yorum" });
      let rows = await rowsFor(owner.workspaceId);
      expect(rows.map((r) => r.userId)).toEqual([owner.userId]);
      expect(rows[0]).toMatchObject({ type: "POST_COMMENT", path: `messages/${post.id}`, body: "İlk yorum" });

      await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
      await createComment(bob, post.id, { body: "İkinci" });
      rows = await rowsFor(owner.workspaceId);
      expect(rows.map((r) => r.userId).sort()).toEqual([owner.userId, alice.userId].sort());

      // The post author commenting on their own post: only the earlier commenters.
      await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
      await createComment(owner, post.id, { body: "Teşekkürler" });
      rows = await rowsFor(owner.workspaceId);
      expect(rows.map((r) => r.userId).sort()).toEqual([alice.userId, bob.userId].sort());
      expect(rows.some((r) => r.userId === admin.userId)).toBe(false);
    });

    it("new event notifies all other members with a calendar path", async () => {
      await createEvent(bob, { title: "Toplantı", startsAt: "2026-03-10T10:00", endsAt: "2026-03-10T11:00" });
      const rows = await rowsFor(owner.workspaceId);
      expect(rows.map((r) => r.userId).sort()).toEqual([owner.userId, admin.userId, alice.userId].sort());
      expect(rows[0]).toMatchObject({
        type: "EVENT_CREATED",
        path: "calendar?month=2026-03#agenda-2026-03-10",
        body: "Toplantı",
      });
    });

    it("a member joining via invitation notifies OWNERs and ADMINs only", async () => {
      const invitee = await createTestUser();
      const { token } = await createInvitation(admin, { email: invitee.email, role: "MEMBER" });
      await acceptInvitation({ userId: invitee.id, email: invitee.email }, token);
      const rows = await rowsFor(owner.workspaceId);
      expect(rows.map((r) => r.userId).sort()).toEqual([owner.userId, admin.userId].sort());
      expect(rows.every((r) => r.type === "MEMBER_JOINED" && r.actorId === invitee.id && r.path === "settings")).toBe(
        true,
      );
      // Re-accepting (already a member) does not notify again.
      await acceptInvitation({ userId: invitee.id, email: invitee.email }, token);
      expect(await rowsFor(owner.workspaceId)).toHaveLength(2);
    });

    it("a notification failure never fails the main action", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      // notify() writes inside db.$transaction (lock + insert); createPost does not use one.
      const createMany = vi.spyOn(db, "$transaction").mockRejectedValue(new Error("db down"));
      try {
        const post = await createPost(alice, { title: "Yine de kaydedilir", body: "x" });
        expect(await db.post.count({ where: { id: post.id } })).toBe(1);
        expect(spy).toHaveBeenCalled();
      } finally {
        createMany.mockRestore();
        spy.mockRestore();
      }
      expect(await rowsFor(owner.workspaceId)).toHaveLength(0);
    });
  });
});

describe("notification preferences", () => {
  afterAll(async () => {
    await cleanup();
  });

  it("muted users skip that type only; defaults unaffected", async () => {
    const o = await createTestUser();
    const { workspace, ctx } = await createTestWorkspace(o.id);
    const { user: m, ctx: mCtx } = await createMember(workspace.id);
    const { user: d } = await createMember(workspace.id);
    expect(await getMutedTypes(mCtx)).toEqual([]);
    await setMutedTypes(mCtx, ["POST_CREATED", "POST_CREATED"]);
    expect(await getMutedTypes(mCtx)).toEqual(["POST_CREATED"]);

    const base = { recipientIds: [m.id, d.id], title: "t", path: "todos" };
    expect(await notify(ctx, { ...base, type: "POST_CREATED" })).toBe(1);
    expect(await db.notification.count({ where: { workspaceId: workspace.id, userId: m.id } })).toBe(0);
    expect(await db.notification.count({ where: { workspaceId: workspace.id, userId: d.id } })).toBe(1);

    expect(await notify(ctx, { ...base, type: "EVENT_CREATED" })).toBe(2);
    expect(await db.notification.count({ where: { workspaceId: workspace.id, userId: m.id } })).toBe(1);

    await setMutedTypes(mCtx, []);
    expect(await notify(ctx, { ...base, type: "POST_CREATED" })).toBe(2);
  });

  it("is per workspace and validates types", async () => {
    const o = await createTestUser();
    const m = await createTestUser();
    const a = await createTestWorkspace(o.id);
    const b = await createTestWorkspace(o.id);
    const mA = await addMember(a.workspace.id, m.id, "MEMBER");
    await addMember(b.workspace.id, m.id, "MEMBER");
    await setMutedTypes(mA, ["EVENT_CREATED"]);
    expect(
      await notify(b.ctx, { recipientIds: [m.id], type: "EVENT_CREATED", title: "t", path: "todos" }),
    ).toBe(1);
    expect(await code(setMutedTypes(mA, ["NOPE"]))).toBe("VALIDATION");
  });
});
