import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { listActivity } from "@/server/activity";
import { addComment } from "@/server/comments";
import { ServiceError } from "@/server/errors";
import {
  createDocument,
  createFolder,
  deleteFolder,
  getDocument,
  listFolderContents,
  restoreFolderTree,
  setFolderInternal,
} from "@/server/files";
import { createPost, updatePost } from "@/server/messages";
import { listNotifications, markRead, unreadCount } from "@/server/notifications";
import { createTodoItem, createTodoList, moveTodoItem, setTodoItemDone } from "@/server/todos";
import { changeMemberRole } from "@/server/workspaces";

import { cleanup, createMember, createTestUser, createTestWorkspace, disconnect, uniqueSuffix } from "./helpers";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e.code;
    throw e;
  }
  return "OK";
}

const TOKEN = `cc${uniqueSuffix()}`;

let owner: TenantContext;
let admin: TenantContext;
let member: TenantContext;
let guest: TenantContext;

beforeAll(async () => {
  const w = await createTestWorkspace((await createTestUser()).id);
  owner = w.ctx;
  admin = (await createMember(owner.workspaceId, "ADMIN")).ctx;
  member = (await createMember(owner.workspaceId, "MEMBER")).ctx;
  guest = (await createMember(owner.workspaceId, "GUEST")).ctx;
});

afterAll(async () => {
  await cleanup();
  await disconnect();
});

const titles = async (ctx: TenantContext) => (await listActivity(ctx, { take: 100 })).items.map((i) => i.title);
const activityOf = (subjectType: string, subjectId: string) =>
  db.activity.findMany({ where: { workspaceId: owner.workspaceId, subjectType, subjectId } });

describe("moving a to-do item between lists re-syncs the feed", () => {
  it("public -> internal hides the item's and its comments' rows from guests", async () => {
    const open = await createTodoList(member, { name: `${TOKEN} acik` });
    const hidden = await createTodoList(member, { name: `${TOKEN} gizli`, internal: true });
    const item = await createTodoItem(member, open.id, { title: `${TOKEN} tasinan gorev` });
    await addComment(member, { type: "todo", id: item.id }, { body: `${TOKEN} yorum` });
    await setTodoItemDone(member, item.id, true);

    expect((await activityOf("todoItem", item.id)).length).toBeGreaterThan(0);
    expect((await activityOf("todoItem", item.id)).every((a) => !a.internal)).toBe(true);
    expect(await titles(guest)).toContain(`${TOKEN} tasinan gorev`);

    await moveTodoItem(member, item.id, { listId: hidden.id });

    expect((await activityOf("todoItem", item.id)).every((a) => a.internal)).toBe(true);
    const commentIds = (await db.comment.findMany({ where: { todoItemId: item.id }, select: { id: true } })).map((c) => c.id);
    expect(commentIds.length).toBe(1);
    for (const cid of commentIds) {
      const rows = await activityOf("comment", cid);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((a) => a.internal)).toBe(true);
    }
    expect(await titles(guest)).not.toContain(`${TOKEN} tasinan gorev`);
    expect(await titles(member)).toContain(`${TOKEN} tasinan gorev`);
  });

  it("internal -> public makes them visible again", async () => {
    const open = await createTodoList(member, { name: `${TOKEN} acik2` });
    const hidden = await createTodoList(member, { name: `${TOKEN} gizli2`, internal: true });
    const item = await createTodoItem(member, hidden.id, { title: `${TOKEN} geri gorev` });
    await addComment(member, { type: "todo", id: item.id }, { body: "y" });
    expect(await titles(guest)).not.toContain(`${TOKEN} geri gorev`);
    await moveTodoItem(member, item.id, { listId: open.id });
    expect((await activityOf("todoItem", item.id)).every((a) => !a.internal)).toBe(true);
    expect(await titles(guest)).toContain(`${TOKEN} geri gorev`);
  });

  it("a reorder inside the same list leaves the rows alone", async () => {
    const list = await createTodoList(member, { name: `${TOKEN} ayni`, internal: true });
    const a = await createTodoItem(member, list.id, { title: `${TOKEN} a` });
    await createTodoItem(member, list.id, { title: `${TOKEN} b` });
    await moveTodoItem(member, a.id, { direction: "down" });
    expect((await activityOf("todoItem", a.id)).every((r) => r.internal)).toBe(true);
  });
});

describe("folder internal flag stays consistent with its ancestors", () => {
  it("refuses to open a subfolder under an internal parent", async () => {
    const a = await createFolder(member, { name: `${TOKEN} A`, internal: true });
    const b = await createFolder(member, { name: `${TOKEN} B`, parentId: a.id });
    expect(b.internal).toBe(true);
    expect(await code(setFolderInternal(member, { id: b.id, internal: false }))).toBe("VALIDATION");
    expect((await db.folder.findUniqueOrThrow({ where: { id: b.id } })).internal).toBe(true);
    await expect(listFolderContents(guest, b.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("opening the parent first, then the child, works; a root folder can still be opened", async () => {
    const a = await createFolder(member, { name: `${TOKEN} P`, internal: true });
    const b = await createFolder(member, { name: `${TOKEN} Q`, parentId: a.id });
    await setFolderInternal(member, { id: a.id, internal: false });
    // the child stays team-only until opened itself
    await expect(listFolderContents(guest, b.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await setFolderInternal(member, { id: b.id, internal: false });
    await expect(listFolderContents(guest, b.id)).resolves.toBeTruthy();
    const root = await createFolder(member, { name: `${TOKEN} R`, internal: true });
    await setFolderInternal(member, { id: root.id, internal: false });
    await expect(listFolderContents(guest, root.id)).resolves.toBeTruthy();
  });

  it("a trashed subfolder is cascaded too, and restoring it keeps it internal", async () => {
    const a = await createFolder(member, { name: `${TOKEN} TA` });
    const c = await createFolder(member, { name: `${TOKEN} TC`, parentId: a.id });
    const doc = await createDocument(member, { title: `${TOKEN} belge`, content: "x", folderId: c.id });
    await deleteFolder(member, c.id);
    await setFolderInternal(member, { id: a.id, internal: true });
    expect((await db.folder.findUniqueOrThrow({ where: { id: c.id } })).internal).toBe(true);
    expect((await db.document.findUniqueOrThrow({ where: { id: doc.id } })).internal).toBe(true);
    await restoreFolderTree(member, c.id);
    await expect(listFolderContents(guest, c.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getDocument(guest, doc.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getDocument(member, doc.id)).resolves.toBeTruthy();
  });

  it("restoring a folder whose parent became internal while it was trashed hides it and its contents", async () => {
    const a = await createFolder(member, { name: `${TOKEN} RA` });
    const c = await createFolder(member, { name: `${TOKEN} RC`, parentId: a.id });
    const sub = await createFolder(member, { name: `${TOKEN} RS`, parentId: c.id });
    await deleteFolder(member, c.id);
    // simulate legacy / racing state: parent internal without the cascade reaching the trash
    await db.folder.update({ where: { id: a.id }, data: { internal: true } });
    await restoreFolderTree(member, c.id);
    expect((await db.folder.findUniqueOrThrow({ where: { id: c.id } })).internal).toBe(true);
    expect((await db.folder.findUniqueOrThrow({ where: { id: sub.id } })).internal).toBe(true);
    await expect(listFolderContents(guest, sub.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("restoring under a public parent keeps the folder public", async () => {
    const a = await createFolder(member, { name: `${TOKEN} PA` });
    const c = await createFolder(member, { name: `${TOKEN} PC`, parentId: a.id });
    await deleteFolder(member, c.id);
    await restoreFolderTree(member, c.id);
    await expect(listFolderContents(guest, c.id)).resolves.toBeTruthy();
  });

  it("a guest still cannot change the flag", async () => {
    const a = await createFolder(member, { name: `${TOKEN} GA` });
    expect(await code(setFolderInternal(guest, { id: a.id, internal: true }))).toBe("FORBIDDEN");
  });
});

describe("demoting to guest drops stale notifications", () => {
  async function seed(userId: string, rows: Array<{ type: string; title: string; path: string }>) {
    await db.notification.createMany({
      data: rows.map((r) => ({ workspaceId: owner.workspaceId, userId, actorId: owner.userId, body: "gizli govde", ...r })),
    });
  }

  it("changeMemberRole -> GUEST deletes that user's notifications in this workspace only", async () => {
    const { ctx: temp } = await createMember(owner.workspaceId, "MEMBER");
    const other = await createTestWorkspace(temp.userId);
    const post = await createPost(member, { title: `${TOKEN} bildirim gizli`, body: "b", internal: true });
    await seed(temp.userId, [
      { type: "POST_CREATED", title: `${TOKEN} bildirim gizli`, path: `messages/${post.id}` },
      { type: "CHAT_DM", title: "dm", path: `chat?with=${member.userId}` },
      { type: "CHECKIN", title: "checkin", path: "checkins" },
    ]);
    await db.notification.create({
      data: { workspaceId: other.workspace.id, userId: temp.userId, type: "TODO_ASSIGNED", title: "baska", path: "todos" },
    });
    const row = await db.membership.findFirstOrThrow({ where: { userId: temp.userId, workspaceId: owner.workspaceId } });
    expect((await listNotifications(temp)).items.length).toBeGreaterThanOrEqual(3);

    await changeMemberRole(admin, row.id, "GUEST");
    const asGuest = { ...temp, role: "GUEST" as const };
    expect((await listNotifications(asGuest)).items).toEqual([]);
    expect(await unreadCount(asGuest)).toBe(0);
    expect(await db.notification.count({ where: { userId: temp.userId, workspaceId: other.workspace.id } })).toBe(1);
  });

  it("other role changes keep notifications", async () => {
    const { ctx: temp } = await createMember(owner.workspaceId, "MEMBER");
    await seed(temp.userId, [{ type: "CHECKIN", title: "k", path: "checkins" }]);
    const row = await db.membership.findFirstOrThrow({ where: { userId: temp.userId, workspaceId: owner.workspaceId } });
    await changeMemberRole(admin, row.id, "ADMIN");
    expect(await db.notification.count({ where: { userId: temp.userId, workspaceId: owner.workspaceId } })).toBe(1);
  });
});

describe("a guest's notification reads hide team-only material", () => {
  it("hides team-only types, and targets that are or became internal", async () => {
    const openPost = await createPost(member, { title: `${TOKEN} np acik`, body: "b" });
    const flipPost = await createPost(member, { title: `${TOKEN} np cevrilen`, body: "b" });
    const hiddenPost = await createPost(member, { title: `${TOKEN} np gizli`, body: "b", internal: true });
    const hiddenList = await createTodoList(member, { name: `${TOKEN} nl`, internal: true });
    const hiddenItem = await createTodoItem(member, hiddenList.id, { title: `${TOKEN} ni` });
    const rows = [
      { type: "POST_CREATED", title: "acik", path: `messages/${openPost.id}` },
      { type: "POST_CREATED", title: "cevrilen", path: `messages/${flipPost.id}` },
      { type: "POST_CREATED", title: "gizli", path: `messages/${hiddenPost.id}` },
      { type: "COMMENT", title: "gizli gorev yorumu", path: `todos/${hiddenItem.id}` },
      { type: "CHAT_DM", title: "dm", path: `chat?with=${member.userId}` },
      { type: "CHECKIN", title: "ci", path: "checkins" },
      { type: "MEMBER_JOINED", title: "mj", path: "settings" },
      { type: "EVENT_CREATED", title: "genel", path: "calendar?month=2026-03#agenda-2026-03-10" },
    ];
    await db.notification.createMany({
      data: rows.map((r) => ({ workspaceId: owner.workspaceId, userId: guest.userId, actorId: member.userId, ...r })),
    });
    const mine = ["acik", "cevrilen", "genel", "gizli", "gizli gorev yorumu", "dm", "ci", "mj"];
    const seen = async () =>
      (await listNotifications(guest, { take: 50 })).items.map((i) => i.title).filter((t) => mine.includes(t)).sort();
    // the posts above also notified the guest for real (open ones only): count the delta, not the total
    const base = await unreadCount(guest);
    expect(await seen()).toEqual(["acik", "cevrilen", "genel"]);

    await updatePost(member, flipPost.id, { title: `${TOKEN} np cevrilen`, body: "b", internal: true });
    expect(await seen()).toEqual(["acik", "genel"]);
    expect(await unreadCount(guest)).toBe(base - 2);

    const hidden = await db.notification.findFirstOrThrow({ where: { userId: guest.userId, title: "gizli" } });
    expect(await code(markRead(guest, hidden.id))).toBe("NOT_FOUND");
    const dm = await db.notification.findFirstOrThrow({ where: { userId: guest.userId, type: "CHAT_DM" } });
    expect(await code(markRead(guest, dm.id))).toBe("NOT_FOUND");
    const ok = await db.notification.findFirstOrThrow({ where: { userId: guest.userId, title: "acik" } });
    await expect(markRead(guest, ok.id)).resolves.toMatchObject({ path: `messages/${openPost.id}` });
  });

  it("does not change what members see", async () => {
    const hiddenPost = await createPost(member, { title: `${TOKEN} mp gizli`, body: "b", internal: true });
    await db.notification.createMany({
      data: [
        { type: "POST_CREATED", title: "mgizli", path: `messages/${hiddenPost.id}` },
        { type: "CHAT_DM", title: "mdm", path: `chat?with=${owner.userId}` },
      ].map((r) => ({ workspaceId: owner.workspaceId, userId: admin.userId, actorId: member.userId, ...r })),
    });
    const t = (await listNotifications(admin, { take: 50 })).items.map((i) => i.title);
    expect(t).toEqual(expect.arrayContaining(["mgizli", "mdm"]));
  });
});
