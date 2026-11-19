import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { formatMentionToken } from "@/lib/mentions";
import type { TenantContext } from "@/lib/tenant-context";
import {
  addComment,
  commentSubjectPath,
  countComments,
  deleteComment,
  listComments,
  mentionNames,
  resolveMentionedMembers,
  updateComment,
  type CommentSubject,
  type CommentSubjectType,
} from "@/server/comments";
import { ServiceError } from "@/server/errors";
import { createPost, updatePost } from "@/server/messages";
import { searchWorkspace } from "@/server/search";
import { getTodoItemDetail } from "@/server/todos";

import { cleanup, createMember, createTestUser, createTestWorkspace, uniqueSuffix } from "./helpers";

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

const TYPES: CommentSubjectType[] = ["post", "todo", "document", "event", "file"];

/** One subject of each type in ctx's workspace, created by `by` (to-do assigned to `assignee`). */
async function seedSubjects(ctx: TenantContext, by: string, assignee?: string) {
  const ws = ctx.workspaceId;
  const post = await db.post.create({ data: { workspaceId: ws, authorId: by, title: "Duyuru", body: "..." } });
  const list = await db.todoList.create({ data: { workspaceId: ws, createdById: by, name: "Sprint" } });
  const todo = await db.todoItem.create({
    data: { workspaceId: ws, listId: list.id, createdById: by, assigneeId: assignee ?? null, title: "Teklif hazırla" },
  });
  const document = await db.document.create({
    data: { workspaceId: ws, authorId: by, title: "Sözleşme", content: "Metin" },
  });
  const event = await db.event.create({
    data: {
      workspaceId: ws,
      createdById: by,
      title: "Toplantı",
      startsAt: new Date("2026-03-10T09:00:00Z"),
      endsAt: new Date("2026-03-10T10:00:00Z"),
    },
  });
  const file = await db.file.create({
    data: {
      workspaceId: ws,
      uploadedById: by,
      name: "rapor.pdf",
      mimeType: "application/pdf",
      size: 10,
      storageKey: `${ws}/${uniqueSuffix()}-rapor.pdf`,
    },
  });
  return {
    file: { type: "file", id: file.id },
    post: { type: "post", id: post.id },
    todo: { type: "todo", id: todo.id },
    document: { type: "document", id: document.id },
    event: { type: "event", id: event.id },
  } satisfies Record<CommentSubjectType, CommentSubject>;
}

describe("comments service", () => {
  let owner: TenantContext;
  let admin: TenantContext;
  let alice: TenantContext;
  let bob: TenantContext;
  let carol: TenantContext;
  let otherOwner: TenantContext;
  let outsider: TenantContext; // member of B only
  let A: Record<CommentSubjectType, CommentSubject>;
  let B: Record<CommentSubjectType, CommentSubject>;

  beforeAll(async () => {
    const u = await createTestUser({ name: "Sahip" });
    owner = (await createTestWorkspace(u.id)).ctx;
    admin = (await createMember(owner.workspaceId, "ADMIN")).ctx;
    alice = (await createMember(owner.workspaceId)).ctx;
    bob = (await createMember(owner.workspaceId)).ctx;
    carol = (await createMember(owner.workspaceId)).ctx;
    const o = await createTestUser();
    otherOwner = (await createTestWorkspace(o.id)).ctx;
    outsider = (await createMember(otherOwner.workspaceId)).ctx;
    // Subjects in A are created by alice; the to-do is assigned to bob.
    A = await seedSubjects(owner, alice.userId, bob.userId);
    B = await seedSubjects(otherOwner, otherOwner.userId);
  });

  beforeEach(async () => {
    await db.notification.deleteMany({ where: { workspaceId: { in: [owner.workspaceId, otherOwner.workspaceId] } } });
  });

  const notes = (workspaceId: string) =>
    db.notification.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

  describe("subject isolation", () => {
    for (const type of TYPES) {
      it(`${type}: ctx A cannot list, add or attach to B's ${type}`, async () => {
        await addComment(otherOwner, B[type], { body: "B gizli" });
        expect(await code(listComments(owner, B[type]))).toBe("NOT_FOUND");
        expect(await code(addComment(owner, B[type], { body: "sızma" }))).toBe("NOT_FOUND");
        expect(await code(addComment(alice, B[type], { body: "sızma" }))).toBe("NOT_FOUND");
        const rows = await db.comment.findMany({ where: { workspaceId: owner.workspaceId, body: "sızma" } });
        expect(rows).toHaveLength(0);
        const inB = await listComments(otherOwner, B[type]);
        expect(inB.map((c) => c.body)).toEqual(["B gizli"]);
      });

      it(`${type}: ctx A cannot edit or delete B's comment`, async () => {
        const c = await addComment(otherOwner, B[type], { body: "dokunma" });
        expect(await code(updateComment(owner, c.id, { body: "x" }))).toBe("NOT_FOUND");
        expect(await code(deleteComment(owner, c.id))).toBe("NOT_FOUND");
        expect((await db.comment.findUniqueOrThrow({ where: { id: c.id } })).body).toBe("dokunma");
      });

      it(`${type}: sets workspaceId from ctx and exactly one key`, async () => {
        const c = await addComment(alice, A[type], { body: "tek anahtar" });
        expect(c.workspaceId).toBe(owner.workspaceId);
        expect(c.authorId).toBe(alice.userId);
        const keys = [c.postId, c.todoItemId, c.documentId, c.eventId, c.fileId].filter(Boolean);
        expect(keys).toEqual([A[type].id]);
        const listed = await listComments(bob, A[type]);
        expect(listed.some((x) => x.id === c.id)).toBe(true);
      });
    }

    it("a subject id of one type is not found as another type", async () => {
      expect(await code(addComment(alice, { type: "todo", id: A.post.id }, { body: "x" }))).toBe("NOT_FOUND");
      expect(await code(listComments(alice, { type: "event", id: A.document.id }))).toBe("NOT_FOUND");
    });

    it("validates subject and body", async () => {
      expect(await code(addComment(alice, { type: "folder" as CommentSubjectType, id: A.post.id }, { body: "x" }))).toBe(
        "VALIDATION",
      );
      expect(await code(addComment(alice, { type: "post", id: "x".repeat(65) }, { body: "x" }))).toBe("VALIDATION");
      expect(await code(addComment(alice, A.post, { body: "   " }))).toBe("VALIDATION");
      expect(await code(addComment(alice, A.post, { body: "a".repeat(5001) }))).toBe("VALIDATION");
    });

    it("a member of another workspace cannot comment on A's subjects", async () => {
      expect(await code(addComment(outsider, A.todo, { body: "x" }))).toBe("NOT_FOUND");
    });
  });

  describe("CHECK constraint", () => {
    it("rejects a comment with no subject or with two subjects", async () => {
      const base = { workspaceId: owner.workspaceId, authorId: alice.userId, body: "x" };
      await expect(db.comment.create({ data: base })).rejects.toThrow();
      await expect(
        db.comment.create({ data: { ...base, postId: A.post.id, todoItemId: A.todo.id } }),
      ).rejects.toThrow();
    });

    it("deleting the subject cascades to its comments", async () => {
      const list = await db.todoList.create({
        data: { workspaceId: owner.workspaceId, createdById: alice.userId, name: "Geçici" },
      });
      const item = await db.todoItem.create({
        data: { workspaceId: owner.workspaceId, listId: list.id, createdById: alice.userId, title: "Sil beni" },
      });
      const c = await addComment(alice, { type: "todo", id: item.id }, { body: "x" });
      await db.todoItem.delete({ where: { id: item.id } });
      expect(await db.comment.findUnique({ where: { id: c.id } })).toBeNull();
    });
  });

  describe("permissions", () => {
    for (const type of TYPES) {
      it(`${type}: authors edit/delete their own; members cannot touch others'; admins can`, async () => {
        const c = await addComment(alice, A[type], { body: "benim" });
        expect(await code(updateComment(bob, c.id, { body: "x" }))).toBe("FORBIDDEN");
        expect(await code(deleteComment(bob, c.id))).toBe("FORBIDDEN");
        expect(await updateComment(alice, c.id, { body: "düzelttim" })).toEqual({ subject: A[type] });
        expect(await code(updateComment(admin, c.id, { body: "yönetici" }))).toBe("OK");
        expect(await deleteComment(owner, c.id)).toEqual({ subject: A[type] });
        expect(await db.comment.findUnique({ where: { id: c.id } })).toBeNull();
      });
    }
  });

  describe("notifications and activity", () => {
    it("post: author and earlier commenters; path to the post", async () => {
      await addComment(bob, A.post, { body: "ilk" });
      await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
      await addComment(carol, A.post, { body: "ikinci" });
      const rows = await notes(owner.workspaceId);
      expect(rows.map((r) => r.userId).sort()).toEqual([alice.userId, bob.userId].sort());
      expect(rows.every((r) => r.type === "POST_COMMENT" && r.path === `messages/${A.post.id}`)).toBe(true);
    });

    it("todo: creator, assignee and earlier commenters", async () => {
      const list = await db.todoList.create({
        data: { workspaceId: owner.workspaceId, createdById: alice.userId, name: "L" },
      });
      const item = await db.todoItem.create({
        data: {
          workspaceId: owner.workspaceId,
          listId: list.id,
          createdById: alice.userId,
          assigneeId: bob.userId,
          title: "Görev X",
        },
      });
      const subject = { type: "todo", id: item.id } as const;
      await addComment(carol, subject, { body: "ilk" });
      let rows = await notes(owner.workspaceId);
      expect(rows.map((r) => r.userId).sort()).toEqual([alice.userId, bob.userId].sort());
      expect(rows[0]).toMatchObject({ type: "COMMENT", path: `todos/${item.id}` });
      expect(rows[0].title).toContain("görevine yorum yaptı");

      await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
      await addComment(admin, subject, { body: "ikinci" });
      rows = await notes(owner.workspaceId);
      expect(rows.map((r) => r.userId).sort()).toEqual([alice.userId, bob.userId, carol.userId].sort());

      // The assignee commenting: creator + earlier commenters, never the actor.
      await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
      await addComment(bob, subject, { body: "üçüncü" });
      rows = await notes(owner.workspaceId);
      expect(rows.map((r) => r.userId).sort()).toEqual([alice.userId, carol.userId, admin.userId].sort());
    });

    it("document: author and earlier commenters", async () => {
      const doc = await db.document.create({
        data: { workspaceId: owner.workspaceId, authorId: alice.userId, title: "Rapor", content: "" },
      });
      const subject = { type: "document", id: doc.id } as const;
      await addComment(bob, subject, { body: "ilk" });
      let rows = await notes(owner.workspaceId);
      expect(rows.map((r) => r.userId)).toEqual([alice.userId]);
      expect(rows[0]).toMatchObject({ type: "COMMENT", path: `files/docs/${doc.id}` });
      await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
      await addComment(alice, subject, { body: "teşekkürler" });
      rows = await notes(owner.workspaceId);
      expect(rows.map((r) => r.userId)).toEqual([bob.userId]);
    });

    it("event: creator and earlier commenters; activity points at the detail page", async () => {
      const event = await db.event.create({
        data: {
          workspaceId: owner.workspaceId,
          createdById: carol.userId,
          title: "Lansman",
          startsAt: new Date("2026-04-01T09:00:00Z"),
          endsAt: new Date("2026-04-01T10:00:00Z"),
        },
      });
      const subject = { type: "event", id: event.id } as const;
      await addComment(alice, subject, { body: "geliyorum" });
      const rows = await notes(owner.workspaceId);
      expect(rows.map((r) => r.userId)).toEqual([carol.userId]);
      expect(rows[0]).toMatchObject({ type: "COMMENT", path: `calendar/${event.id}` });
      const activity = await db.activity.findFirst({
        where: { workspaceId: owner.workspaceId, type: "COMMENT_CREATED", path: `calendar/${event.id}` },
      });
      expect(activity?.title).toBe("Lansman");
    });

    it("never notifies into another workspace", async () => {
      await addComment(otherOwner, B.post, { body: "B" });
      expect(await db.notification.count({ where: { workspaceId: owner.workspaceId } })).toBe(0);
    });
  });

  describe("mentions", () => {
    let names: Record<string, string>;
    beforeAll(async () => {
      const users = await db.user.findMany({
        where: { id: { in: [alice.userId, bob.userId, carol.userId, outsider.userId] } },
        select: { id: true, name: true },
      });
      names = Object.fromEntries(users.map((u) => [u.id, u.name ?? ""]));
    });
    const token = (ctx: TenantContext, label?: string) =>
      formatMentionToken({ id: ctx.userId, name: label ?? names[ctx.userId] });

    it("only current members of the workspace count as mentions", async () => {
      const body = `${token(bob)} ${token(outsider)} @[Yok](user:nope${uniqueSuffix()}) ${token(bob)}`;
      expect(await resolveMentionedMembers(alice, body)).toEqual([bob.userId]);
      const map = await mentionNames(alice, [body]);
      expect(Object.keys(map)).toEqual([bob.userId]);
      expect(map[bob.userId]).toBe(names[bob.userId]);
    });

    it("a spoofed label resolves to the DB name of the id", async () => {
      const map = await mentionNames(alice, [token(bob, "Sahip")]);
      expect(map[bob.userId]).toBe(names[bob.userId]);
    });

    it("one MENTION per mentioned member, not duplicated with the comment notification", async () => {
      // alice authored A.document; mentioning her (and carol) on it.
      const doc = await db.document.create({
        data: { workspaceId: owner.workspaceId, authorId: alice.userId, title: "Plan", content: "" },
      });
      const subject = { type: "document", id: doc.id } as const;
      await addComment(bob, subject, { body: `${token(alice)} ${token(carol)} ${token(alice)} ${token(outsider)}` });
      const rows = await notes(owner.workspaceId);
      const byUser = (id: string) => rows.filter((r) => r.userId === id);
      expect(byUser(alice.userId).map((r) => r.type)).toEqual(["MENTION"]);
      expect(byUser(carol.userId).map((r) => r.type)).toEqual(["MENTION"]);
      expect(byUser(bob.userId)).toHaveLength(0);
      expect(await db.notification.count({ where: { userId: outsider.userId } })).toBe(0);
      const mention = byUser(alice.userId)[0];
      expect(mention.path).toBe(`files/docs/${doc.id}`);
      expect(mention.title).toContain("sizden bahsetti");
      // The body shows names, not raw tokens.
      expect(mention.body).toContain(`@${names[alice.userId]}`);
      expect(mention.body).not.toContain("user:");
    });

    it("the author mentioning themself gets nothing", async () => {
      await addComment(alice, A.event, { body: token(alice) });
      expect(await db.notification.count({ where: { workspaceId: owner.workspaceId, userId: alice.userId } })).toBe(0);
    });

    it("editing notifies only newly added mentions", async () => {
      const c = await addComment(alice, A.todo, { body: `Merhaba ${token(carol)}` });
      await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
      await updateComment(alice, c.id, { body: `Merhaba ${token(carol)} ve ${token(admin, "Yönetici")}` });
      let rows = await notes(owner.workspaceId);
      expect(rows.map((r) => [r.userId, r.type])).toEqual([[admin.userId, "MENTION"]]);
      await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
      await updateComment(alice, c.id, { body: `Son hali ${token(carol)}` });
      rows = await notes(owner.workspaceId);
      expect(rows).toHaveLength(0);
    });

    it("posts: mentioned members get MENTION instead of POST_CREATED; edits notify new mentions", async () => {
      const post = await createPost(alice, { title: "Haber", body: `Bakar mısınız ${token(bob)}` });
      let rows = await notes(owner.workspaceId);
      expect(rows.filter((r) => r.userId === bob.userId).map((r) => r.type)).toEqual(["MENTION"]);
      expect(rows.filter((r) => r.type === "POST_CREATED").map((r) => r.userId).sort()).toEqual(
        [owner.userId, admin.userId, carol.userId].sort(),
      );
      await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
      await updatePost(alice, post.id, { title: "Haber", body: `Bakar mısınız ${token(bob)} ${token(carol)}` });
      rows = await notes(owner.workspaceId);
      expect(rows.map((r) => [r.userId, r.type])).toEqual([[carol.userId, "MENTION"]]);
      expect(rows[0].path).toBe(`messages/${post.id}`);
    });
  });

  describe("reads", () => {
    it("countComments groups in one query and ignores other workspaces", async () => {
      const list = await db.todoList.create({ data: { workspaceId: owner.workspaceId, createdById: alice.userId, name: "C" } });
      const [i1, i2] = await Promise.all(
        ["Bir", "İki"].map((title) =>
          db.todoItem.create({ data: { workspaceId: owner.workspaceId, listId: list.id, createdById: alice.userId, title } }),
        ),
      );
      await addComment(alice, { type: "todo", id: i1.id }, { body: "1" });
      await addComment(bob, { type: "todo", id: i1.id }, { body: "2" });
      await addComment(bob, { type: "todo", id: i2.id }, { body: "3" });
      const counts = await countComments(owner, "todo", [i1.id, i2.id, B.todo.id]);
      expect(counts).toEqual({ [i1.id]: 2, [i2.id]: 1 });
    });

    it("getTodoItemDetail is scoped by workspace", async () => {
      const item = await getTodoItemDetail(owner, A.todo.id);
      expect(item.list.name).toBe("Sprint");
      expect(item.assignee?.id).toBe(bob.userId);
      expect(await code(getTodoItemDetail(owner, B.todo.id))).toBe("NOT_FOUND");
      expect(await code(getTodoItemDetail(owner, "x".repeat(65)))).toBe("VALIDATION");
    });

    it("search links comment results to the right subject for all five types", async () => {
      const marker = `qz${uniqueSuffix()}`;
      for (const type of TYPES) await addComment(alice, A[type], { body: `${type} ${marker}` });
      await addComment(otherOwner, B.post, { body: `B ${marker}` });
      const res = await searchWorkspace(owner, { q: marker, types: ["comment"], limitPerType: 10 });
      const items = res.groups[0].items;
      expect(items).toHaveLength(TYPES.length);
      const paths = items.map((i) => i.path).sort();
      expect(paths).toEqual(TYPES.map((t) => commentSubjectPath(A[t])).sort());
      expect(paths).toContain(`messages/${A.post.id}`);
      expect(paths).toContain(`todos/${A.todo.id}`);
      expect(paths).toContain(`files/docs/${A.document.id}`);
      expect(paths).toContain(`calendar/${A.event.id}`);
      expect(paths).toContain(`files/view/${A.file.id}`);
      const todoHit = items.find((i) => i.path === `todos/${A.todo.id}`);
      expect(todoHit?.title.text).toBe("Teklif hazırla");
    });
  });
});
