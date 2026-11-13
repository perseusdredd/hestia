import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { createLocalDriver, type StorageDriver } from "@/lib/storage";
import type { TenantContext } from "@/lib/tenant-context";
import { ACTIVITY_GROUPS, ACTIVITY_TITLE_MAX, forgetActivity, listActivity, recordActivity } from "@/server/activity";
import { createEvent, deleteEvent, updateEvent } from "@/server/calendar";
import { addComment, deleteComment } from "@/server/comments";
import {
  acceptLocalUpload,
  completeUpload,
  createDocument,
  createFolder,
  createPendingUpload,
  deleteDocument,
  deleteFile,
  deleteFolder,
  updateDocument,
} from "@/server/files";
import { createComment, createPost, deletePost } from "@/server/messages";
import { createTodoItem, createTodoList, deleteTodoItem, deleteTodoList, setTodoItemDone } from "@/server/todos";
import {
  acceptInvitation,
  changeMemberRole,
  createInvitation,
  leaveWorkspace,
  removeMember,
} from "@/server/workspaces";

import { cleanup, createMember, createTestUser, createTestWorkspace, deleteTestUser } from "./helpers";

let root: string;
let storage: StorageDriver;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hestia-activity-"));
  storage = createLocalDriver(root);
});

afterAll(async () => {
  await cleanup();
  await rm(root, { recursive: true, force: true });
});

async function freshWorkspace() {
  const owner = await createTestUser();
  return (await createTestWorkspace(owner.id)).ctx;
}

const rows = (workspaceId: string) =>
  db.activity.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

/** Runs `fn` and returns the activity rows it added to ctx's workspace. */
async function added(ctx: TenantContext, fn: () => Promise<unknown>) {
  const before = new Set((await rows(ctx.workspaceId)).map((r) => r.id));
  await fn();
  return (await rows(ctx.workspaceId)).filter((r) => !before.has(r.id));
}

function expectOne(
  list: { type: string; path: string; actorId: string | null; title: string }[],
  type: string,
  p: string,
  actorId: string,
) {
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ type, path: p, actorId });
}

describe("activity triggers (one row per action)", () => {
  let ctx: TenantContext;
  let member: TenantContext;
  beforeAll(async () => {
    ctx = await freshWorkspace();
    ({ ctx: member } = await createMember(ctx.workspaceId, "MEMBER"));
  });

  it("posts and comments", async () => {
    let postId = "";
    const a = await added(ctx, async () => {
      postId = (await createPost(ctx, { title: "Lansman planı", body: "Detaylar" })).id;
    });
    expectOne(a, "POST_CREATED", `messages/${postId}`, ctx.userId);
    expect(a[0].title).toBe("Lansman planı");

    const b = await added(ctx, () => createComment(member, postId, { body: "Harika" }));
    expectOne(b, "COMMENT_CREATED", `messages/${postId}`, member.userId);
  });

  it("to-do lists, items, complete and reopen", async () => {
    let listId = "";
    const a = await added(ctx, async () => {
      listId = (await createTodoList(member, { name: "Sprint" })).id;
    });
    expectOne(a, "TODO_LIST_CREATED", "todos", member.userId);

    let itemId = "";
    const b = await added(ctx, async () => {
      itemId = (await createTodoItem(member, listId, { title: "Taslağı yaz" })).id;
    });
    expectOne(b, "TODO_CREATED", "todos", member.userId);

    const c = await added(ctx, () => setTodoItemDone(ctx, itemId, true));
    expectOne(c, "TODO_COMPLETED", "todos", ctx.userId);
    expect(c[0].title).toBe("Taslağı yaz");

    const d = await added(ctx, () => setTodoItemDone(ctx, itemId, false));
    expectOne(d, "TODO_REOPENED", "todos", ctx.userId);
  });

  it("events created and updated link to the agenda day", async () => {
    let eventId = "";
    const a = await added(ctx, async () => {
      eventId = (await createEvent(ctx, { title: "Toplantı", startsAt: "2026-03-10T10:00", endsAt: "2026-03-10T11:00" }))
        .id;
    });
    expectOne(a, "EVENT_CREATED", "calendar?month=2026-03#agenda-2026-03-10", ctx.userId);

    const b = await added(ctx, () =>
      updateEvent(ctx, eventId, { title: "Toplantı 2", startsAt: "2026-04-02T09:00", endsAt: "2026-04-02T10:00" }),
    );
    expectOne(b, "EVENT_UPDATED", "calendar?month=2026-04#agenda-2026-04-02", ctx.userId);
    expect(b[0].title).toBe("Toplantı 2");
  });

  it("folders, uploads and documents", async () => {
    let folderId = "";
    const a = await added(ctx, async () => {
      folderId = (await createFolder(ctx, { name: "Teklifler" })).id;
    });
    expectOne(a, "FOLDER_CREATED", `files/${folderId}`, ctx.userId);

    const bytes = new TextEncoder().encode("merhaba");
    const pending = await createPendingUpload(
      member,
      { name: "not.txt", size: bytes.byteLength, type: "text/plain", folderId },
      storage,
    );
    await acceptLocalUpload(member.userId, pending.token, bytes, bytes.byteLength, storage);
    const b = await added(ctx, () => completeUpload(member, pending.token, storage));
    expectOne(b, "FILE_UPLOADED", `files/${folderId}`, member.userId);
    // An idempotent retry of the same completion records nothing.
    expect(await added(ctx, () => completeUpload(member, pending.token, storage))).toHaveLength(0);

    let docId = "";
    const c = await added(ctx, async () => {
      docId = (await createDocument(ctx, { title: "Brif", content: "" })).id;
    });
    expectOne(c, "DOCUMENT_CREATED", `files/docs/${docId}`, ctx.userId);

    const d = await added(ctx, () => updateDocument(ctx, { id: docId, title: "Brif v2", content: "metin" }));
    expectOne(d, "DOCUMENT_UPDATED", `files/docs/${docId}`, ctx.userId);
  });

  it("members join, change role, get removed and leave", async () => {
    const invitee = await createTestUser({ name: "Ayşe Yılmaz" });
    const { token } = await createInvitation(ctx, { email: invitee.email, role: "MEMBER" });
    const a = await added(ctx, () => acceptInvitation({ userId: invitee.id, email: invitee.email }, token));
    expectOne(a, "MEMBER_JOINED", "settings", invitee.id);
    expect(a[0].title).toBe("Ayşe Yılmaz");
    // Idempotent re-accept: no second row.
    expect(await added(ctx, () => acceptInvitation({ userId: invitee.id, email: invitee.email }, token))).toHaveLength(0);

    const m = await db.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: invitee.id, workspaceId: ctx.workspaceId } },
    });
    const b = await added(ctx, () => changeMemberRole(ctx, m.id, "ADMIN"));
    expectOne(b, "MEMBER_ROLE_CHANGED", "settings", ctx.userId);
    expect(b[0].title).toContain("Ayşe Yılmaz");
    // Same role again: nothing changed, nothing recorded.
    expect(await added(ctx, () => changeMemberRole(ctx, m.id, "ADMIN"))).toHaveLength(0);

    const c = await added(ctx, () => removeMember(ctx, m.id));
    expectOne(c, "MEMBER_REMOVED", "settings", ctx.userId);

    const { user: leaver, ctx: leaverCtx } = await createMember(ctx.workspaceId, "MEMBER");
    const d = await added(ctx, () => leaveWorkspace(leaverCtx));
    expectOne(d, "MEMBER_LEFT", "settings", leaver.id);
  });
});

describe("recordActivity", () => {
  it("trims, collapses whitespace and caps the title", async () => {
    const ctx = await freshWorkspace();
    expect(await recordActivity(ctx, { type: "POST_CREATED", title: "  Merhaba \n  dünya  ", path: "messages" })).toBe(
      true,
    );
    expect(await recordActivity(ctx, { type: "POST_CREATED", title: "x".repeat(500), path: "messages" })).toBe(true);
    const [first, second] = await rows(ctx.workspaceId);
    expect(first.title).toBe("Merhaba dünya");
    expect(second.title.length).toBeLessThanOrEqual(ACTIVITY_TITLE_MAX);
  });

  it("rejects unsafe paths, unknown types and empty titles without throwing", async () => {
    const ctx = await freshWorkspace();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const bad of [
        "https://evil.example/x",
        "//evil.example",
        "/w/other/messages",
        "../settings",
        "messages/../../x",
        "javascript:alert(1)",
        "",
        "messages/a b",
      ]) {
        expect(await recordActivity(ctx, { type: "POST_CREATED", title: "x", path: bad })).toBe(false);
      }
      expect(
        await recordActivity(ctx, { type: "CHAT_MESSAGE" as "POST_CREATED", title: "x", path: "messages" }),
      ).toBe(false);
      expect(await recordActivity(ctx, { type: "POST_CREATED", title: "   ", path: "messages" })).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(await rows(ctx.workspaceId)).toHaveLength(0);
  });

  it("a ctx for a workspace the user left (or never joined) cannot write", async () => {
    const ctx = await freshWorkspace();
    const { ctx: member } = await createMember(ctx.workspaceId, "MEMBER");
    await leaveWorkspace(member);
    const before = (await rows(ctx.workspaceId)).length;
    expect(await recordActivity(member, { type: "POST_CREATED", title: "sızma", path: "messages" })).toBe(false);

    const outsider = await createTestUser();
    const forged: TenantContext = { userId: outsider.id, workspaceId: ctx.workspaceId, role: "OWNER" };
    expect(await recordActivity(forged, { type: "POST_CREATED", title: "sızma", path: "messages" })).toBe(false);
    expect(await rows(ctx.workspaceId)).toHaveLength(before);
  });

  it("a failing insert never fails the user's action", async () => {
    const ctx = await freshWorkspace();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const create = vi.spyOn(db.activity, "create").mockRejectedValue(new Error("db down"));
    try {
      const post = await createPost(ctx, { title: "Yine de kaydedilir", body: "gövde" });
      expect(post.id).toBeTruthy();
      const list = await createTodoList(ctx, { name: "Liste" });
      expect(list.id).toBeTruthy();
      expect(create).toHaveBeenCalledTimes(2);
      expect(err).toHaveBeenCalled();
    } finally {
      create.mockRestore();
      err.mockRestore();
    }
    expect(await db.post.count({ where: { workspaceId: ctx.workspaceId } })).toBe(1);
    expect(await rows(ctx.workspaceId)).toHaveLength(0);
  });
});

describe("listActivity", () => {
  it("is scoped to ctx's workspace", async () => {
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    await createPost(a, { title: "A gönderisi", body: "a" });
    await createPost(b, { title: "B gönderisi", body: "b" });
    const listA = await listActivity(a);
    expect(listA.items.map((i) => i.title)).toEqual(["A gönderisi"]);
    // Filtering by B's owner from A still only sees A's rows.
    expect((await listActivity(a, { actorId: b.userId })).items).toHaveLength(0);
  });

  it("paginates newest first with no duplicates or skips on identical timestamps", async () => {
    const ctx = await freshWorkspace();
    const same = new Date("2026-05-01T09:00:00.000Z");
    await db.activity.createMany({
      data: Array.from({ length: 23 }, (_, i) => ({
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        type: "TODO_CREATED",
        title: `Görev ${i}`,
        path: "todos",
        createdAt: i < 3 ? new Date("2026-05-02T09:00:00.000Z") : same,
      })),
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof listActivity>> = await listActivity(ctx, { cursor, take: 5 });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      expect(page.hasMore).toBe(cursor !== null);
      pages++;
    } while (cursor && pages < 20);
    expect(pages).toBe(5);
    expect(new Set(seen).size).toBe(23);
    const all = await db.activity.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    expect(seen).toEqual(all.map((r) => r.id));
  });

  it("rejects malformed cursors", async () => {
    const ctx = await freshWorkspace();
    const bad = [
      "not a cursor!",
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({ t: "yesterday", i: "x" })).toString("base64url"),
      "x".repeat(300),
    ];
    for (const cursor of bad) {
      await expect(listActivity(ctx, { cursor })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(listActivity(ctx, { take: 0 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(listActivity(ctx, { take: 1000 })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("filters by type group and by member", async () => {
    const ctx = await freshWorkspace();
    const { ctx: member } = await createMember(ctx.workspaceId, "MEMBER");
    await createPost(ctx, { title: "Duyuru", body: "x" });
    const list = await createTodoList(member, { name: "Liste" });
    await createTodoItem(member, list.id, { title: "İş" });
    await createFolder(ctx, { name: "Klasör" });

    const todos = await listActivity(ctx, { types: [...ACTIVITY_GROUPS.todos] });
    expect(todos.items.map((i) => i.type).sort()).toEqual(["TODO_CREATED", "TODO_LIST_CREATED"]);

    const byMember = await listActivity(ctx, { actorId: member.userId });
    expect(byMember.items.every((i) => i.actor?.id === member.userId)).toBe(true);
    expect(byMember.items).toHaveLength(2);

    const both = await listActivity(ctx, { types: [...ACTIVITY_GROUPS.messages], actorId: member.userId });
    expect(both.items).toHaveLength(0);

    await expect(listActivity(ctx, { types: ["NOPE" as "POST_CREATED"] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("includes the actor and keeps rows whose actor was deleted", async () => {
    const ctx = await freshWorkspace();
    const { user, ctx: member } = await createMember(ctx.workspaceId, "MEMBER");
    await createPost(member, { title: "Eski üye gönderisi", body: "x" });
    const withActor = await listActivity(ctx);
    expect(withActor.items[0].actor).toMatchObject({ id: user.id, name: user.name });

    await deleteTestUser(user.id);
    const after = await listActivity(ctx);
    expect(after.items).toHaveLength(1);
    expect(after.items[0].actor).toBeNull();
    expect(after.items[0].title).toBe("Eski üye gönderisi");
  });

  it("never returns an unsafe stored path as a link", async () => {
    const ctx = await freshWorkspace();
    await db.activity.create({
      data: { workspaceId: ctx.workspaceId, actorId: ctx.userId, type: "POST_CREATED", title: "x", path: "//evil" },
    });
    expect((await listActivity(ctx)).items[0].path).toBeNull();
  });
});

describe("deleting content removes its feed rows", () => {
  it("deletePost drops the post and comment rows, not other workspaces' rows", async () => {
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const post = await createPost(a, { title: "Gizli gönderi", body: "x" });
    await createComment(a, post.id, { body: "yorum" });
    await createPost(a, { title: "Kalan gönderi", body: "y" });
    // A row in B with the same path (cannot happen naturally) must survive.
    await recordActivity(b, { type: "POST_CREATED", title: "B satırı", path: `messages/${post.id}` });

    await deletePost(a, post.id);
    const titles = (await listActivity(a)).items.map((i) => i.title);
    expect(titles).not.toContain("Gizli gönderi");
    expect(titles).toContain("Kalan gönderi");
    expect((await listActivity(b)).items.map((i) => i.title)).toContain("B satırı");
  });

  it("deleteDocument drops its created/updated rows", async () => {
    const a = await freshWorkspace();
    const doc = await createDocument(a, { title: "Maaş zammı listesi", content: "" });
    await updateDocument(a, { id: doc.id, title: "Maaş zammı listesi v2", content: "x" });
    await deleteDocument(a, doc.id);
    const titles = (await listActivity(a)).items.map((i) => i.title);
    expect(titles.some((t) => t.startsWith("Maaş zammı"))).toBe(false);
  });

  it("deleteFolder drops rows of the folder tree and the documents in it", async () => {
    const a = await freshWorkspace();
    const parent = await createFolder(a, { name: "Silinecek klasör" });
    const child = await createFolder(a, { name: "Alt klasör", parentId: parent.id });
    await createDocument(a, { title: "İçerideki doküman", content: "", folderId: child.id });
    await createFolder(a, { name: "Kalan klasör" });
    await deleteFolder(a, parent.id, storage);
    const titles = (await listActivity(a)).items.map((i) => i.title);
    expect(titles).toEqual(["Kalan klasör"]);
  });
});

describe("activity subjects", () => {
  /** Subject columns of every row in the workspace, as "type:id", oldest first. */
  async function subjects(workspaceId: string) {
    return (await rows(workspaceId)).map((r) => `${r.subjectType}:${r.subjectId}`);
  }

  async function upload(ctx: TenantContext, name: string, folderId: string | null = null) {
    const bytes = new TextEncoder().encode(name);
    const pending = await createPendingUpload(ctx, { name, size: bytes.byteLength, type: "text/plain", folderId }, storage);
    await acceptLocalUpload(ctx.userId, pending.token, bytes, bytes.byteLength, storage);
    return completeUpload(ctx, pending.token, storage);
  }

  it("every content row records its subject", async () => {
    const ctx = await freshWorkspace();
    const post = await createPost(ctx, { title: "Gönderi", body: "x" });
    const comment = await createComment(ctx, post.id, { body: "yorum" });
    const list = await createTodoList(ctx, { name: "Liste" });
    const item = await createTodoItem(ctx, list.id, { title: "Görev" });
    await setTodoItemDone(ctx, item.id, true);
    const event = await createEvent(ctx, { title: "Etkinlik", startsAt: "2026-03-10T10:00", endsAt: "2026-03-10T11:00" });
    await updateEvent(ctx, event.id, { title: "Etkinlik 2", startsAt: "2026-03-10T10:00", endsAt: "2026-03-10T11:00" });
    const folder = await createFolder(ctx, { name: "Klasör" });
    const file = await upload(ctx, "a.txt", folder.id);
    const doc = await createDocument(ctx, { title: "Doküman", content: "" });
    await updateDocument(ctx, { id: doc.id, title: "Doküman 2", content: "x" });

    const expected = [
      `post:${post.id}`,
      `comment:${comment.id}`,
      `todoList:${list.id}`,
      `todoItem:${item.id}`,
      `todoItem:${item.id}`,
      `event:${event.id}`,
      `event:${event.id}`,
      `folder:${folder.id}`,
      `file:${file.id}`,
      `document:${doc.id}`,
      `document:${doc.id}`,
    ];
    expect((await subjects(ctx.workspaceId)).sort()).toEqual(expected.sort());
  });

  it("member rows have no subject", async () => {
    const ctx = await freshWorkspace();
    const invitee = await createTestUser();
    const { token } = await createInvitation(ctx, { email: invitee.email, role: "MEMBER" });
    await acceptInvitation({ userId: invitee.id, email: invitee.email }, token);
    const [row] = await rows(ctx.workspaceId);
    expect(row).toMatchObject({ type: "MEMBER_JOINED", subjectType: null, subjectId: null });
  });

  it("rejects an unknown subject type without throwing", async () => {
    const ctx = await freshWorkspace();
    const bad = { type: "chat" as "post", id: "x" };
    expect(await recordActivity(ctx, { type: "POST_CREATED", title: "x", path: "messages", subject: bad })).toBe(false);
    expect(await rows(ctx.workspaceId)).toHaveLength(0);
  });

  it("deleteComment drops only that comment's row", async () => {
    const ctx = await freshWorkspace();
    const list = await createTodoList(ctx, { name: "Liste" });
    const item = await createTodoItem(ctx, list.id, { title: "Görev" });
    const keep = await addComment(ctx, { type: "todo", id: item.id }, { body: "kalsın" });
    const gone = await addComment(ctx, { type: "todo", id: item.id }, { body: "silinsin" });
    await deleteComment(ctx, gone.id);
    const left = await subjects(ctx.workspaceId);
    expect(left).toContain(`comment:${keep.id}`);
    expect(left).not.toContain(`comment:${gone.id}`);
    expect(left).toContain(`todoItem:${item.id}`);
  });

  it("deleteTodoItem drops the item's rows and its comments' rows", async () => {
    const ctx = await freshWorkspace();
    const list = await createTodoList(ctx, { name: "Liste" });
    const item = await createTodoItem(ctx, list.id, { title: "Gizli görev" });
    const other = await createTodoItem(ctx, list.id, { title: "Kalan görev" });
    await setTodoItemDone(ctx, item.id, true);
    await addComment(ctx, { type: "todo", id: item.id }, { body: "yorum" });
    await deleteTodoItem(ctx, item.id);
    const titles = (await listActivity(ctx)).items.map((i) => i.title);
    expect(titles).not.toContain("Gizli görev");
    expect(titles.sort()).toEqual(["Kalan görev", "Liste"]);
    expect(await subjects(ctx.workspaceId)).toContain(`todoItem:${other.id}`);
  });

  it("deleteTodoList drops the list, its items and their comments", async () => {
    const ctx = await freshWorkspace();
    const list = await createTodoList(ctx, { name: "Silinecek liste" });
    const item = await createTodoItem(ctx, list.id, { title: "İçerideki görev" });
    await addComment(ctx, { type: "todo", id: item.id }, { body: "yorum" });
    const keep = await createTodoList(ctx, { name: "Kalan liste" });
    await deleteTodoList(ctx, list.id);
    expect((await listActivity(ctx)).items.map((i) => i.title)).toEqual(["Kalan liste"]);
    expect(await subjects(ctx.workspaceId)).toEqual([`todoList:${keep.id}`]);
  });

  it("deleteEvent drops the event's created/updated rows and its comments", async () => {
    const ctx = await freshWorkspace();
    const event = await createEvent(ctx, { title: "Gizli toplantı", startsAt: "2026-03-10T10:00", endsAt: "2026-03-10T11:00" });
    await updateEvent(ctx, event.id, { title: "Gizli toplantı 2", startsAt: "2026-03-10T10:00", endsAt: "2026-03-10T11:00" });
    await addComment(ctx, { type: "event", id: event.id }, { body: "yorum" });
    await createEvent(ctx, { title: "Kalan toplantı", startsAt: "2026-03-11T10:00", endsAt: "2026-03-11T11:00" });
    await deleteEvent(ctx, event.id);
    expect((await listActivity(ctx)).items.map((i) => i.title)).toEqual(["Kalan toplantı"]);
  });

  it("deleteFile drops the upload row", async () => {
    const ctx = await freshWorkspace();
    const file = await upload(ctx, "gizli.txt");
    await upload(ctx, "kalan.txt");
    await deleteFile(ctx, file.id, storage);
    expect((await listActivity(ctx)).items.map((i) => i.title)).toEqual(["kalan.txt"]);
  });

  it("deleteDocument drops its comments' rows too", async () => {
    const ctx = await freshWorkspace();
    const doc = await createDocument(ctx, { title: "Gizli doküman", content: "" });
    await addComment(ctx, { type: "document", id: doc.id }, { body: "yorum" });
    await deleteDocument(ctx, doc.id);
    expect(await rows(ctx.workspaceId)).toHaveLength(0);
  });

  it("deletePost drops comment rows by subject", async () => {
    const ctx = await freshWorkspace();
    const post = await createPost(ctx, { title: "Gizli", body: "x" });
    await createComment(ctx, post.id, { body: "yorum" });
    await deletePost(ctx, post.id);
    expect(await rows(ctx.workspaceId)).toHaveLength(0);
  });

  it("deleteFolder drops uploads, documents and document comments inside the tree", async () => {
    const ctx = await freshWorkspace();
    const parent = await createFolder(ctx, { name: "Silinecek" });
    const child = await createFolder(ctx, { name: "Alt", parentId: parent.id });
    await upload(ctx, "içeride.txt", child.id);
    const doc = await createDocument(ctx, { title: "İçerideki doküman", content: "", folderId: child.id });
    await addComment(ctx, { type: "document", id: doc.id }, { body: "yorum" });
    await upload(ctx, "dışarıda.txt");
    await deleteFolder(ctx, parent.id, storage);
    expect((await listActivity(ctx)).items.map((i) => i.title)).toEqual(["dışarıda.txt"]);
  });

  it("is scoped to ctx's workspace and also removes legacy rows (no subject) by path", async () => {
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const item = await createTodoItem(a, (await createTodoList(a, { name: "L" })).id, { title: "Görev" });
    // The same subject in B (cannot happen naturally) must survive.
    await recordActivity(b, {
      type: "TODO_CREATED",
      title: "B satırı",
      path: "todos",
      subject: { type: "todoItem", id: item.id },
    });
    // A comment row written before subjects existed (path only).
    await db.activity.create({
      data: { workspaceId: a.workspaceId, actorId: a.userId, type: "COMMENT_CREATED", title: "Eski", path: `todos/${item.id}` },
    });
    // A legacy row with an unrelated path stays.
    await db.activity.create({
      data: { workspaceId: a.workspaceId, actorId: a.userId, type: "TODO_CREATED", title: "Eski liste satırı", path: "todos" },
    });
    expect(await forgetActivity(a, [{ type: "todoItem", id: item.id }])).toBe(2);
    expect((await listActivity(a)).items.map((i) => i.title).sort()).toEqual(["Eski liste satırı", "L"]);
    expect((await listActivity(b)).items.map((i) => i.title)).toContain("B satırı");
    expect(await forgetActivity(a, [])).toBe(0);
  });
});
