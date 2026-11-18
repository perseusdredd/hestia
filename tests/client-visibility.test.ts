import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { buildIcs } from "@/lib/ical";
import { canModify, clientVisibleWhere, hasRole, isGuest, ROLE_LABELS, ROLES } from "@/lib/roles";
import { createLocalDriver, type StorageDriver } from "@/lib/storage";
import type { TenantContext } from "@/lib/tenant-context";
import { listActivity } from "@/server/activity";
import { listBookmarks, toggleBookmark } from "@/server/bookmarks";
import { createEvent, getEvent, listEventsForFeed, listMonth, listUpcomingEvents, updateEvent } from "@/server/calendar";
import { createColumn, listBoard } from "@/server/cards";
import { listCheckins } from "@/server/checkins";
import { listMessages as listChatMessages, sendChatMessage, listConversations } from "@/server/chat";
import { documentClientWhere, fileClientWhere, resolveInternal, todoItemClientWhere } from "@/server/client-visibility";
import { listComments } from "@/server/comments";
import { ServiceError } from "@/server/errors";
import {
  acceptInvitation,
  changeMemberRole,
  createInvitation,
  createInviteLink,
  renameWorkspace,
} from "@/server/workspaces";
import {
  acceptLocalUpload,
  authorizeFileAccess,
  completeUpload,
  createDocument,
  createFolder,
  createPendingUpload,
  getDocument,
  getFileDownload,
  getFileInline,
  getFilePreview,
  listFolderContents,
  listFolderTree,
  listRecentItems,
  moveDocument,
  setFolderInternal,
  updateDocument,
} from "@/server/files";
import { setHillPosition } from "@/server/hill";
import { createCategory } from "@/server/message-categories";
import {
  createComment,
  createPost,
  deleteComment,
  deletePost,
  getPost,
  getPostHeader,
  listPosts,
  setPostPinned,
  updatePost,
} from "@/server/messages";
import { listNotifications, unreadCount } from "@/server/notifications";
import { getOverviewCounts } from "@/server/overview";
import { createProject } from "@/server/projects";
import { getReports } from "@/server/reports";
import { searchWorkspace } from "@/server/search";
import { listMySubscriptions, subscribe } from "@/server/subscriptions";
import {
  createTodoItem,
  createTodoList,
  getTodoItemDetail,
  listMyOpenTodos,
  listTodoLists,
  setTodoItemDone,
  updateTodoItem,
  updateTodoList,
} from "@/server/todos";
import { listTrash, restoreTrashItem } from "@/server/trash";

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

const TOKEN = `cv${uniqueSuffix()}`;
const MONTH_EVENT = { startsAt: "2026-03-10T10:00", endsAt: "2026-03-10T11:00" };

let root: string;
let storage: StorageDriver;
let owner: TenantContext;
let admin: TenantContext;
let member: TenantContext;
let member2: TenantContext;
let guest: TenantContext;
let otherOwner: TenantContext;

async function upload(ctx: TenantContext, name: string, content: string, folderId: string | null = null) {
  const bytes = new TextEncoder().encode(content);
  const pending = await createPendingUpload(ctx, { name, size: bytes.byteLength, type: "text/plain", folderId }, storage);
  await acceptLocalUpload(ctx.userId, pending.token, bytes, bytes.byteLength, storage);
  return completeUpload(ctx, pending.token, storage);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hestia-cv-"));
  storage = createLocalDriver(root);
  const w = await createTestWorkspace((await createTestUser()).id);
  owner = w.ctx;
  admin = (await createMember(owner.workspaceId, "ADMIN")).ctx;
  member = (await createMember(owner.workspaceId, "MEMBER")).ctx;
  member2 = (await createMember(owner.workspaceId, "MEMBER")).ctx;
  guest = (await createMember(owner.workspaceId, "GUEST")).ctx;
  otherOwner = (await createTestWorkspace((await createTestUser()).id)).ctx;
});

afterAll(async () => {
  await cleanup();
  await disconnect();
  await rm(root, { recursive: true, force: true });
});

describe("role helpers", () => {
  it("adds GUEST below MEMBER without changing the others", () => {
    expect(ROLES).toEqual(["OWNER", "ADMIN", "MEMBER", "GUEST"]);
    expect(ROLE_LABELS.GUEST).toBe("Misafir / Müşteri");
    expect(hasRole("GUEST", "MEMBER")).toBe(false);
    expect(hasRole("GUEST", "GUEST")).toBe(true);
    expect(hasRole("MEMBER", "GUEST")).toBe(true);
    expect(hasRole("MEMBER", "MEMBER")).toBe(true);
    expect(hasRole("ADMIN", "MEMBER")).toBe(true);
    expect(hasRole("MEMBER", "ADMIN")).toBe(false);
    expect(isGuest("GUEST")).toBe(true);
    for (const r of ["OWNER", "ADMIN", "MEMBER"] as const) expect(isGuest(r)).toBe(false);
  });

  it("clientVisibleWhere hides internal rows from guests only", () => {
    expect(clientVisibleWhere({ role: "GUEST" })).toEqual({ internal: false });
    for (const role of ["OWNER", "ADMIN", "MEMBER"] as const) expect(clientVisibleWhere({ role })).toEqual({});
    expect(todoItemClientWhere({ role: "GUEST" })).toEqual({ list: { internal: false } });
    expect(todoItemClientWhere({ role: "MEMBER" })).toEqual({});
    expect(fileClientWhere({ role: "MEMBER" })).toEqual({});
    expect(documentClientWhere({ role: "ADMIN" })).toEqual({});
    expect(fileClientWhere({ role: "GUEST" })).toBeTruthy();
  });

  it("a guest never creates internal rows", () => {
    expect(resolveInternal({ role: "GUEST" }, true)).toBe(false);
    expect(resolveInternal({ role: "MEMBER" }, true)).toBe(true);
    expect(resolveInternal({ role: "MEMBER" }, undefined)).toBe(false);
  });

  it("a guest only edits their own content (canModify unchanged)", () => {
    expect(canModify(guest, guest.userId)).toBe(true);
    expect(canModify(guest, member.userId)).toBe(false);
    expect(canModify(admin, member.userId)).toBe(true);
  });
});

describe("messages", () => {
  let open: { id: string };
  let hidden: { id: string };
  let legacy: { id: string };

  beforeAll(async () => {
    open = await createPost(member, { title: `${TOKEN} acik`, body: `${TOKEN}msg herkese acik` });
    hidden = await createPost(member, { title: `${TOKEN} gizli`, body: `${TOKEN}msg ekip icin`, internal: true });
    // A row that never heard of the flag (the DB default) is visible to everybody.
    legacy = await db.post.create({
      data: {
        workspaceId: owner.workspaceId,
        authorId: member.userId,
        title: `${TOKEN} eski`,
        body: "eski",
        publishedAt: new Date(),
      },
    });
  });

  it("defaults to visible (internal = false)", async () => {
    const row = await db.post.findUniqueOrThrow({ where: { id: open.id } });
    expect(row.internal).toBe(false);
    expect((await db.post.findUniqueOrThrow({ where: { id: legacy.id } })).internal).toBe(false);
    expect((await db.post.findUniqueOrThrow({ where: { id: hidden.id } })).internal).toBe(true);
  });

  it("a guest lists only non-internal posts, a member lists both", async () => {
    const g = (await listPosts(guest, { take: 50 })).items.map((p) => p.id);
    expect(g).toContain(open.id);
    expect(g).toContain(legacy.id);
    expect(g).not.toContain(hidden.id);
    const m = (await listPosts(member2, { take: 50 })).items;
    expect(m.map((p) => p.id)).toEqual(expect.arrayContaining([open.id, legacy.id, hidden.id]));
    expect(m.find((p) => p.id === hidden.id)?.internal).toBe(true);
    for (const ctx of [owner, admin]) {
      expect((await listPosts(ctx, { take: 50 })).items.map((p) => p.id)).toContain(hidden.id);
    }
  });

  it("a guest cannot open, read or comment on an internal post", async () => {
    await expect(getPostHeader(guest, hidden.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getPost(guest, hidden.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await code(createComment(guest, hidden.id, { body: "merhaba" }))).toBe("NOT_FOUND");
    expect(await code(listComments(guest, { type: "post", id: hidden.id }))).toBe("NOT_FOUND");
    expect((await getPostHeader(member2, hidden.id)).internal).toBe(true);
    expect((await getPostHeader(guest, open.id)).id).toBe(open.id);
  });

  it("a guest can comment on a visible post", async () => {
    const c = await createComment(guest, open.id, { body: "cevap" });
    expect(c.authorId).toBe(guest.userId);
    expect((await listComments(member2, { type: "post", id: open.id })).map((x) => x.id)).toContain(c.id);
  });

  it("a guest cannot delete or edit others' posts, pin, or change the flag", async () => {
    expect(await code(deletePost(guest, open.id))).toBe("FORBIDDEN");
    expect(await code(updatePost(guest, open.id, { title: "x", body: "y" }))).toBe("FORBIDDEN");
    expect(await code(setPostPinned(guest, open.id, true))).toBe("FORBIDDEN");
    expect(await code(deletePost(guest, hidden.id))).toBe("NOT_FOUND");
    expect(await code(updatePost(guest, hidden.id, { title: "x", body: "y" }))).toBe("NOT_FOUND");
  });

  it("a guest's own posts are always visible to guests; the flag cannot be set by them", async () => {
    const p = await createPost(guest, { title: `${TOKEN} misafir`, body: "b", internal: true });
    expect((await db.post.findUniqueOrThrow({ where: { id: p.id } })).internal).toBe(false);
    await updatePost(guest, p.id, { title: `${TOKEN} misafir 2`, body: "b", internal: true });
    expect((await db.post.findUniqueOrThrow({ where: { id: p.id } })).internal).toBe(false);
    await expect(deletePost(guest, p.id)).resolves.toBeUndefined();
  });

  it("members can flip the flag on edit", async () => {
    const p = await createPost(member, { title: `${TOKEN} flip`, body: "b" });
    await updatePost(member, p.id, { title: `${TOKEN} flip`, body: "b", internal: true });
    expect((await db.post.findUniqueOrThrow({ where: { id: p.id } })).internal).toBe(true);
    await expect(getPostHeader(guest, p.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await updatePost(member, p.id, { title: `${TOKEN} flip`, body: "b", internal: false });
    await expect(getPostHeader(guest, p.id)).resolves.toBeTruthy();
    // Omitted = unchanged.
    await updatePost(member, p.id, { title: `${TOKEN} flip`, body: "c" });
    expect((await db.post.findUniqueOrThrow({ where: { id: p.id } })).internal).toBe(false);
  });

  it("search finds internal posts for members but never for guests", async () => {
    const g = await searchWorkspace(guest, { q: `${TOKEN}msg`, types: ["post"] });
    const gIds = g.groups.flatMap((x) => x.items.map((i) => i.id));
    expect(gIds).toContain(open.id);
    expect(gIds).not.toContain(hidden.id);
    const m = await searchWorkspace(member2, { q: `${TOKEN}msg`, types: ["post"] });
    expect(m.groups.flatMap((x) => x.items.map((i) => i.id))).toEqual(expect.arrayContaining([open.id, hidden.id]));
  });

  it("comment search does not leak comments on internal posts", async () => {
    await createComment(member, hidden.id, { body: `${TOKEN}secretcomment` });
    await createComment(member, open.id, { body: `${TOKEN}publiccomment` });
    const gs = await searchWorkspace(guest, { q: `${TOKEN}secretcomment`, types: ["comment"] });
    expect(gs.total).toBe(0);
    const gp = await searchWorkspace(guest, { q: `${TOKEN}publiccomment`, types: ["comment"] });
    expect(gp.total).toBe(1);
    const ms = await searchWorkspace(member2, { q: `${TOKEN}secretcomment`, types: ["comment"] });
    expect(ms.total).toBe(1);
  });

  it("bookmarks and subscriptions respect visibility", async () => {
    expect(await code(toggleBookmark(guest, { type: "post", id: hidden.id }))).toBe("NOT_FOUND");
    expect(await code(subscribe(guest, { type: "post", id: hidden.id }))).toBe("NOT_FOUND");
    await toggleBookmark(guest, { type: "post", id: open.id }, true);
    await toggleBookmark(member2, { type: "post", id: hidden.id }, true);
    expect((await listBookmarks(guest)).map((b) => b.id)).toEqual([open.id]);
    expect((await listBookmarks(member2)).map((b) => b.id)).toContain(hidden.id);
    // Bookmarked before the post became internal: it disappears for the guest.
    await db.bookmark.create({
      data: { userId: guest.userId, workspaceId: owner.workspaceId, subjectType: "post", subjectId: hidden.id },
    });
    expect((await listBookmarks(guest)).map((b) => b.id)).not.toContain(hidden.id);
    await db.subscription.create({
      data: { userId: guest.userId, workspaceId: owner.workspaceId, subjectType: "post", subjectId: hidden.id },
    });
    expect((await listMySubscriptions(guest)).map((s) => s.id)).not.toContain(hidden.id);
  });

  it("reactions cannot target comments of internal posts for guests", async () => {
    const { toggleReaction } = await import("@/server/reactions");
    const c = await createComment(member, hidden.id, { body: "x" });
    expect(await code(toggleReaction(guest, { type: "comment", id: c.id }, "👍"))).toBe("NOT_FOUND");
    expect(await code(toggleReaction(member2, { type: "comment", id: c.id }, "👍"))).toBe("OK");
  });
});

describe("notifications", () => {
  it("a guest is not notified about an internal post but is about a visible one", async () => {
    const before = (await listNotifications(guest)).items.length;
    const hiddenPost = await createPost(member, {
      title: `${TOKEN} bildirim gizli`,
      body: `@[x](user:${guest.userId}) merhaba`,
      internal: true,
    });
    expect((await listNotifications(guest)).items.length).toBe(before);
    expect((await listNotifications(member2)).items.some((n) => n.path === `messages/${hiddenPost.id}`)).toBe(true);

    const visible = await createPost(member, { title: `${TOKEN} bildirim acik`, body: "herkese" });
    const items = (await listNotifications(guest)).items;
    expect(items.some((n) => n.path === `messages/${visible.id}`)).toBe(true);
    expect(await unreadCount(guest)).toBeGreaterThan(0);
  });

  it("comments on an internal post do not notify a subscribed guest", async () => {
    const p = await createPost(member, { title: `${TOKEN} yorum gizli`, body: "b", internal: true });
    await db.subscription.create({
      data: { userId: guest.userId, workspaceId: owner.workspaceId, subjectType: "post", subjectId: p.id },
    });
    const before = (await listNotifications(guest)).items.length;
    await createComment(member2, p.id, { body: "ekip yorumu" });
    expect((await listNotifications(guest)).items.length).toBe(before);
  });

  it("an internal event notifies the team but not guests", async () => {
    const before = (await listNotifications(guest)).items.length;
    const ev = await createEvent(member, {
      title: `${TOKEN} gizli etkinlik`,
      ...MONTH_EVENT,
      internal: true,
      inviteeIds: [guest.userId, member2.userId],
    });
    expect((await listNotifications(guest)).items.length).toBe(before);
    expect((await listNotifications(member2)).items.some((n) => n.path === `calendar/${ev.id}`)).toBe(true);
    const open = await createEvent(member, { title: `${TOKEN} acik etkinlik`, ...MONTH_EVENT });
    expect((await listNotifications(guest)).items.length).toBe(before + 1);
    expect(open.internal).toBe(false);
  });

  it("assigning a guest to a to-do on an internal list does not notify them", async () => {
    const list = await createTodoList(member, { name: `${TOKEN} gizli liste`, internal: true });
    const before = (await listNotifications(guest)).items.length;
    await createTodoItem(member, list.id, { title: "gorev", assigneeId: guest.userId });
    expect((await listNotifications(guest)).items.length).toBe(before);
    const open = await createTodoList(member, { name: `${TOKEN} acik liste` });
    await createTodoItem(member, open.id, { title: "gorev2", assigneeId: guest.userId });
    expect((await listNotifications(guest)).items.length).toBe(before + 1);
  });
});

describe("to-dos", () => {
  let openList: { id: string };
  let hiddenList: { id: string };
  let openItem: { id: string };
  let hiddenItem: { id: string };

  beforeAll(async () => {
    openList = await createTodoList(member, { name: `${TOKEN} todo acik` });
    hiddenList = await createTodoList(member, { name: `${TOKEN} todo gizli`, internal: true });
    openItem = await createTodoItem(member, openList.id, { title: `${TOKEN}todo acik gorev`, assigneeId: guest.userId });
    hiddenItem = await createTodoItem(member, hiddenList.id, {
      title: `${TOKEN}todo gizli gorev`,
      assigneeId: guest.userId,
    });
  });

  it("a guest sees only non-internal lists and their items", async () => {
    const g = await listTodoLists(guest);
    const ids = g.map((l) => l.id);
    expect(ids).toContain(openList.id);
    expect(ids).not.toContain(hiddenList.id);
    expect(g.flatMap((l) => l.items.map((i) => i.id))).not.toContain(hiddenItem.id);
    const m = await listTodoLists(member2);
    expect(m.map((l) => l.id)).toEqual(expect.arrayContaining([openList.id, hiddenList.id]));
    expect(m.find((l) => l.id === hiddenList.id)?.internal).toBe(true);
    expect(m.find((l) => l.id === openList.id)?.internal).toBe(false);
  });

  it("done items of internal lists stay hidden too", async () => {
    await setTodoItemDone(member, hiddenItem.id, true);
    const g = await listTodoLists(guest);
    expect(g.flatMap((l) => l.items.map((i) => i.id))).not.toContain(hiddenItem.id);
    const m = await listTodoLists(member2);
    expect(m.flatMap((l) => l.items.map((i) => i.id))).toContain(hiddenItem.id);
    await setTodoItemDone(member, hiddenItem.id, false);
  });

  it("my open to-dos, detail and completion respect the flag", async () => {
    const mine = await listMyOpenTodos(guest, { today: "2026-03-10", take: 50 });
    expect(mine.items.map((i) => i.id)).toContain(openItem.id);
    expect(mine.items.map((i) => i.id)).not.toContain(hiddenItem.id);
    const memberView = await listMyOpenTodos({ ...member2, userId: guest.userId, role: "MEMBER" }, { today: "2026-03-10", take: 50 });
    expect(memberView.items.map((i) => i.id)).toContain(hiddenItem.id);
    expect(memberView.total).toBeGreaterThan(mine.total);
    await expect(getTodoItemDetail(guest, hiddenItem.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getTodoItemDetail(guest, openItem.id)).list.id).toBe(openList.id);
    expect((await getTodoItemDetail(member2, hiddenItem.id)).list.internal).toBe(true);
    expect(await code(setTodoItemDone(guest, hiddenItem.id, true))).toBe("NOT_FOUND");
    expect(await code(setTodoItemDone(guest, openItem.id, true))).toBe("OK");
    await setTodoItemDone(guest, openItem.id, false);
  });

  it("a guest cannot add to, edit or delete internal lists and others' items", async () => {
    expect(await code(createTodoItem(guest, hiddenList.id, { title: "x" }))).toBe("NOT_FOUND");
    expect(await code(updateTodoList(guest, hiddenList.id, { name: "x" }))).toBe("NOT_FOUND");
    expect(await code(updateTodoItem(guest, openItem.id, { title: "x" }))).toBe("FORBIDDEN");
    expect(await code(updateTodoList(guest, openList.id, { name: "x" }))).toBe("FORBIDDEN");
  });

  it("comments on an item of an internal list are hidden from guests", async () => {
    await expect(createComment(guest, hiddenItem.id, { body: "x" })).rejects.toBeTruthy();
    const { addComment } = await import("@/server/comments");
    expect(await code(addComment(guest, { type: "todo", id: hiddenItem.id }, { body: "x" }))).toBe("NOT_FOUND");
    expect(await code(addComment(guest, { type: "todo", id: openItem.id }, { body: "ok" }))).toBe("OK");
    expect(await code(addComment(member, { type: "todo", id: hiddenItem.id }, { body: "ekip" }))).toBe("OK");
  });

  it("members flip the list flag; guests cannot", async () => {
    const l = await createTodoList(member, { name: `${TOKEN} flip liste` });
    await updateTodoList(guest, l.id, { name: "x" }).catch(() => undefined);
    await updateTodoList(member, l.id, { internal: true });
    expect((await listTodoLists(guest)).map((x) => x.id)).not.toContain(l.id);
    await updateTodoList(admin, l.id, { internal: false });
    expect((await listTodoLists(guest)).map((x) => x.id)).toContain(l.id);
    const own = await createTodoList(guest, { name: `${TOKEN} misafir liste`, internal: true });
    expect((await db.todoList.findUniqueOrThrow({ where: { id: own.id } })).internal).toBe(false);
  });

  it("the hill chart of an internal list is not reachable for guests", async () => {
    expect(await code(setHillPosition(guest, openList.id, 40))).toBe("FORBIDDEN");
    expect(await code(setHillPosition(member, hiddenList.id, 40))).toBe("OK");
  });

  it("search and overview counts hide internal items from guests", async () => {
    const gt = await searchWorkspace(guest, { q: `${TOKEN}todo`, types: ["todo"] });
    const gl = await searchWorkspace(guest, { q: `${TOKEN} todo`, types: ["list"] });
    const todoIds = gt.groups[0].items.map((i) => i.id);
    const listIds = gl.groups[0].items.map((i) => i.id);
    expect(todoIds).toContain(openItem.id);
    expect(todoIds).not.toContain(hiddenItem.id);
    expect(listIds).toContain(openList.id);
    expect(listIds).not.toContain(hiddenList.id);
    const mt = await searchWorkspace(member2, { q: `${TOKEN}todo`, types: ["todo"] });
    expect(mt.groups[0].items.map((i) => i.id)).toContain(hiddenItem.id);
    const ml = await searchWorkspace(member2, { q: `${TOKEN} todo`, types: ["list"] });
    expect(ml.groups[0].items.map((i) => i.id)).toContain(hiddenList.id);

    const gc = await getOverviewCounts(guest, { today: "2026-03-10" });
    const mc = await getOverviewCounts(member2, { today: "2026-03-10" });
    expect(mc.openTodos).toBeGreaterThan(gc.openTodos);
  });
});

describe("files and documents", () => {
  let openFolder: { id: string };
  let hiddenFolder: { id: string };
  let openFile: { id: string };
  let hiddenFile: { id: string };
  let openDoc: { id: string };
  let hiddenDoc: { id: string };
  let docInHidden: { id: string };

  beforeAll(async () => {
    openFolder = await createFolder(member, { name: `${TOKEN} acik klasor` });
    hiddenFolder = await createFolder(member, { name: `${TOKEN} gizli klasor`, internal: true });
    openFile = await upload(member, `${TOKEN}acik.txt`, "acik", openFolder.id);
    hiddenFile = await upload(member, `${TOKEN}gizli.txt`, "gizli", hiddenFolder.id);
    openDoc = await createDocument(member, { title: `${TOKEN} acik dok`, content: "c", folderId: openFolder.id });
    hiddenDoc = await createDocument(member, {
      title: `${TOKEN} gizli dok`,
      content: "c",
      folderId: openFolder.id,
      internal: true,
    });
    docInHidden = await createDocument(member, { title: `${TOKEN} klasorde dok`, content: "c", folderId: hiddenFolder.id });
  });

  it("defaults and inheritance", async () => {
    expect((await db.folder.findUniqueOrThrow({ where: { id: openFolder.id } })).internal).toBe(false);
    expect((await db.document.findUniqueOrThrow({ where: { id: openDoc.id } })).internal).toBe(false);
    // Created inside an internal folder: internal too.
    expect((await db.document.findUniqueOrThrow({ where: { id: docInHidden.id } })).internal).toBe(true);
    const sub = await createFolder(member, { name: `${TOKEN} alt`, parentId: hiddenFolder.id });
    expect(sub.internal).toBe(true);
  });

  it("a guest lists only non-internal folders and documents", async () => {
    const root = await listFolderContents(guest, null);
    const ids = root.folders.map((f) => f.id);
    expect(ids).toContain(openFolder.id);
    expect(ids).not.toContain(hiddenFolder.id);
    const mroot = await listFolderContents(member2, null);
    expect(mroot.folders.map((f) => f.id)).toEqual(expect.arrayContaining([openFolder.id, hiddenFolder.id]));

    const inOpen = await listFolderContents(guest, openFolder.id);
    expect(inOpen.documents.map((d) => d.id)).toEqual([openDoc.id]);
    expect(inOpen.files.map((f) => f.id)).toEqual([openFile.id]);
    const mOpen = await listFolderContents(member2, openFolder.id);
    expect(mOpen.documents.map((d) => d.id).sort()).toEqual([openDoc.id, hiddenDoc.id].sort());

    await expect(listFolderContents(guest, hiddenFolder.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listFolderContents(member2, hiddenFolder.id)).files.map((f) => f.id)).toEqual([hiddenFile.id]);
    expect((await listFolderTree(guest)).map((f) => f.id)).not.toContain(hiddenFolder.id);
    expect((await listFolderTree(member2)).map((f) => f.id)).toContain(hiddenFolder.id);
  });

  it("a guest cannot open internal documents", async () => {
    await expect(getDocument(guest, hiddenDoc.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getDocument(guest, docInHidden.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getDocument(guest, openDoc.id)).document.id).toBe(openDoc.id);
    expect((await getDocument(member2, hiddenDoc.id)).document.internal).toBe(true);
  });

  it("download, inline and preview of an internal file are denied to guests", async () => {
    // authorizeFileAccess resolves the ctx from the DB (the route handlers' first step).
    const gctx = await authorizeFileAccess(guest.userId, hiddenFile.id);
    expect(gctx?.role).toBe("GUEST");
    await expect(getFileDownload(gctx!, hiddenFile.id, storage)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getFileInline(gctx!, hiddenFile.id, {}, storage)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getFilePreview(gctx!, hiddenFile.id, storage)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Members and visible files still work.
    await expect(getFileDownload(member2, hiddenFile.id, storage)).resolves.toBeTruthy();
    await expect(getFileDownload(guest, openFile.id, storage)).resolves.toBeTruthy();
  });

  it("a root file is visible to guests", async () => {
    const f = await upload(member, `${TOKEN}kok.txt`, "kok");
    await expect(getFileDownload(guest, f.id, storage)).resolves.toBeTruthy();
  });

  it("a guest cannot upload into, move into or create inside an internal folder", async () => {
    expect(await code(createPendingUpload(guest, { name: "a.txt", size: 1, type: "text/plain", folderId: hiddenFolder.id }, storage))).toBe(
      "NOT_FOUND",
    );
    expect(await code(createFolder(guest, { name: "x", parentId: hiddenFolder.id }))).toBe("NOT_FOUND");
    expect(await code(createDocument(guest, { title: "x", content: "y", folderId: hiddenFolder.id }))).toBe("NOT_FOUND");
    expect(await code(updateDocument(guest, { id: hiddenDoc.id, title: "x", content: "y" }))).toBe("NOT_FOUND");
    expect(await code(setFolderInternal(guest, { id: openFolder.id, internal: true }))).toBe("FORBIDDEN");
  });

  it("recents and search never show internal files, folders or documents to guests", async () => {
    const recents = await listRecentItems(guest, { take: 50 });
    const rids = recents.map((r) => r.id);
    expect(rids).toContain(openFile.id);
    expect(rids).toContain(openDoc.id);
    for (const id of [hiddenFile.id, hiddenDoc.id, docInHidden.id]) expect(rids).not.toContain(id);
    const mrecents = (await listRecentItems(member2, { take: 50 })).map((r) => r.id);
    expect(mrecents).toEqual(expect.arrayContaining([hiddenFile.id, hiddenDoc.id]));

    const g = await searchWorkspace(guest, { q: TOKEN, types: ["file", "folder", "document"], limitPerType: 50 });
    const gIds = g.groups.flatMap((x) => x.items.map((i) => i.id));
    expect(gIds).toEqual(expect.arrayContaining([openFile.id, openFolder.id, openDoc.id]));
    for (const id of [hiddenFile.id, hiddenFolder.id, hiddenDoc.id, docInHidden.id]) expect(gIds).not.toContain(id);
    const m = await searchWorkspace(member2, { q: TOKEN, types: ["file", "folder", "document"], limitPerType: 50 });
    const mIds = m.groups.flatMap((x) => x.items.map((i) => i.id));
    expect(mIds).toEqual(expect.arrayContaining([hiddenFile.id, hiddenFolder.id, hiddenDoc.id, docInHidden.id]));
  });

  it("switching a folder to internal cascades to subfolders and documents", async () => {
    const parent = await createFolder(member, { name: `${TOKEN} kaskad` });
    const child = await createFolder(member, { name: `${TOKEN} kaskad alt`, parentId: parent.id });
    const doc = await createDocument(member, { title: `${TOKEN} kaskad dok`, content: "c", folderId: child.id });
    const file = await upload(member, `${TOKEN}kaskad.txt`, "k", child.id);
    await expect(getDocument(guest, doc.id)).resolves.toBeTruthy();
    await setFolderInternal(member, { id: parent.id, internal: true });
    expect((await db.folder.findUniqueOrThrow({ where: { id: child.id } })).internal).toBe(true);
    expect((await db.document.findUniqueOrThrow({ where: { id: doc.id } })).internal).toBe(true);
    await expect(getDocument(guest, doc.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getFileDownload(guest, file.id, storage)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Reopening the parent shows the parent again; the child stays team-only.
    await setFolderInternal(member, { id: parent.id, internal: false });
    expect((await listFolderContents(guest, null)).folders.map((f) => f.id)).toContain(parent.id);
    expect((await listFolderContents(guest, parent.id)).folders).toEqual([]);
  });

  it("moving a document or folder into an internal folder makes it internal", async () => {
    const doc = await createDocument(member, { title: `${TOKEN} tasinan`, content: "c" });
    await expect(getDocument(guest, doc.id)).resolves.toBeTruthy();
    await moveDocument(member, { id: doc.id, targetFolderId: hiddenFolder.id });
    await expect(getDocument(guest, doc.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { moveFolder } = await import("@/server/files");
    const f = await createFolder(member, { name: `${TOKEN} tasinan klasor` });
    await moveFolder(member, { id: f.id, targetFolderId: hiddenFolder.id });
    expect((await db.folder.findUniqueOrThrow({ where: { id: f.id } })).internal).toBe(true);
  });

  it("guests cannot touch others' files or folders (existing ownership rules)", async () => {
    const { deleteFile, deleteFolder, renameFolder } = await import("@/server/files");
    expect(await code(deleteFile(guest, openFile.id))).toBe("FORBIDDEN");
    expect(await code(deleteFolder(guest, openFolder.id))).toBe("FORBIDDEN");
    expect(await code(renameFolder(guest, { id: openFolder.id, name: "z" }))).toBe("FORBIDDEN");
  });
});

describe("calendar", () => {
  let open: { id: string };
  let hidden: { id: string };

  beforeAll(async () => {
    open = await createEvent(member, { title: `${TOKEN} takvim acik`, ...MONTH_EVENT });
    hidden = await createEvent(member, { title: `${TOKEN} takvim gizli`, ...MONTH_EVENT, internal: true });
  });

  it("a guest sees only non-internal events in the month, the feed and the detail", async () => {
    const g = await listMonth(guest, "2026-03");
    const gIds = g.events.map((e) => e.id);
    expect(gIds).toContain(open.id);
    expect(gIds).not.toContain(hidden.id);
    expect(g.occurrences.map((o) => o.event.id)).not.toContain(hidden.id);
    const m = await listMonth(member2, "2026-03");
    expect(m.events.map((e) => e.id)).toEqual(expect.arrayContaining([open.id, hidden.id]));

    await expect(getEvent(guest, hidden.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getEvent(guest, open.id)).id).toBe(open.id);
    expect((await getEvent(member2, hidden.id)).internal).toBe(true);

    const gFeed = (await listEventsForFeed(guest)).map((e) => e.id);
    expect(gFeed).toContain(open.id);
    expect(gFeed).not.toContain(hidden.id);
    expect(buildIcs(await listEventsForFeed(guest), { name: "x" })).not.toContain("takvim gizli");
    expect(buildIcs(await listEventsForFeed(member2), { name: "x" })).toContain("takvim gizli");
  });

  it("upcoming events hide internal ones from guests", async () => {
    const now = new Date("2026-03-01T00:00:00Z");
    const g = await listUpcomingEvents(guest, { days: 30, take: 50, now });
    expect(g.map((e) => e.id)).toContain(open.id);
    expect(g.map((e) => e.id)).not.toContain(hidden.id);
    expect((await listUpcomingEvents(member2, { days: 30, take: 50, now })).map((e) => e.id)).toContain(hidden.id);
  });

  it("to-do due-date markers of internal lists are hidden from guests", async () => {
    const list = await createTodoList(member, { name: `${TOKEN} takvim liste`, internal: true });
    const item = await createTodoItem(member, list.id, { title: `${TOKEN} isaret`, dueDate: "2026-03-12" });
    const g = await listMonth(guest, "2026-03");
    expect(g.todos.map((t) => t.id)).not.toContain(item.id);
    expect((await listMonth(member2, "2026-03")).todos.map((t) => t.id)).toContain(item.id);
  });

  it("guests cannot edit internal events or others' events; the flag is not theirs to set", async () => {
    expect(await code(updateEvent(guest, hidden.id, { title: "x", ...MONTH_EVENT }))).toBe("NOT_FOUND");
    expect(await code(updateEvent(guest, open.id, { title: "x", ...MONTH_EVENT }))).toBe("FORBIDDEN");
    const own = await createEvent(guest, { title: `${TOKEN} misafir etkinlik`, ...MONTH_EVENT, internal: true });
    expect(own.internal).toBe(false);
    expect((await updateEvent(guest, own.id, { title: "y", ...MONTH_EVENT, internal: true })).internal).toBe(false);
    const flipped = await updateEvent(member, open.id, { title: `${TOKEN} takvim acik`, ...MONTH_EVENT, internal: true });
    expect(flipped.internal).toBe(true);
    await expect(getEvent(guest, open.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await updateEvent(member, open.id, { title: `${TOKEN} takvim acik`, ...MONTH_EVENT, internal: false });
    await expect(getEvent(guest, open.id)).resolves.toBeTruthy();
  });

  it("comments on an internal event are hidden from guests", async () => {
    const { addComment } = await import("@/server/comments");
    expect(await code(addComment(guest, { type: "event", id: hidden.id }, { body: "x" }))).toBe("NOT_FOUND");
    expect(await code(addComment(guest, { type: "event", id: open.id }, { body: "x" }))).toBe("OK");
    expect(await code(searchWorkspace(guest, { q: `${TOKEN} takvim`, types: ["event"] }))).toBe("OK");
    const s = await searchWorkspace(guest, { q: `${TOKEN} takvim`, types: ["event"] });
    const ids = s.groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(hidden.id);
  });
});

describe("activity feed", () => {
  it("guests do not see internal activity or member changes", async () => {
    const p = await createPost(member, { title: `${TOKEN} akis gizli`, body: "b", internal: true });
    const q = await createPost(member, { title: `${TOKEN} akis acik`, body: "b" });
    const g = (await listActivity(guest, { take: 100 })).items.map((i) => i.title);
    expect(g).toContain(`${TOKEN} akis acik`);
    expect(g).not.toContain(`${TOKEN} akis gizli`);
    const m = (await listActivity(member2, { take: 100 })).items.map((i) => i.title);
    expect(m).toEqual(expect.arrayContaining([`${TOKEN} akis acik`, `${TOKEN} akis gizli`]));
    const gTypes = (await listActivity(guest, { take: 100 })).items.map((i) => i.type);
    expect(gTypes.some((t) => t.startsWith("MEMBER_"))).toBe(false);
    expect((await listActivity(member2, { take: 100 })).items.some((i) => i.type.startsWith("MEMBER_"))).toBe(false);
    await db.activity.create({
      data: { workspaceId: owner.workspaceId, actorId: member.userId, type: "MEMBER_JOINED", title: "Biri", path: "settings" },
    });
    expect((await listActivity(guest, { take: 100 })).items.some((i) => i.type === "MEMBER_JOINED")).toBe(false);
    expect((await listActivity(member2, { take: 100 })).items.some((i) => i.type === "MEMBER_JOINED")).toBe(true);
    void p;
    void q;
  });

  it("comments, items and files inherit the flag, and flipping it re-syncs the feed", async () => {
    const list = await createTodoList(member, { name: `${TOKEN} akis liste`, internal: true });
    const item = await createTodoItem(member, list.id, { title: `${TOKEN} akis gorev` });
    const titles = async (ctx: TenantContext) => (await listActivity(ctx, { take: 100 })).items.map((i) => i.title);
    expect(await titles(guest)).not.toContain(`${TOKEN} akis gorev`);
    expect(await titles(member2)).toContain(`${TOKEN} akis gorev`);
    await updateTodoList(member, list.id, { internal: false });
    expect(await titles(guest)).toContain(`${TOKEN} akis gorev`);
    expect(await titles(guest)).toContain(`${TOKEN} akis liste`);
    await updateTodoList(member, list.id, { internal: true });
    expect(await titles(guest)).not.toContain(`${TOKEN} akis gorev`);
    void item;

    const folder = await createFolder(member, { name: `${TOKEN} akis klasor`, internal: true });
    const file = await upload(member, `${TOKEN}akis.txt`, "x", folder.id);
    expect(await titles(guest)).not.toContain(file.name);
    expect(await titles(member2)).toContain(file.name);
    await setFolderInternal(member, { id: folder.id, internal: false });
    expect(await titles(guest)).toContain(file.name);

    const post = await createPost(member, { title: `${TOKEN} akis yorumlu`, body: "b", internal: true });
    await createComment(member2, post.id, { body: "c" });
    const countFor = async (ctx: TenantContext) =>
      (await listActivity(ctx, { take: 100, types: ["COMMENT_CREATED"] })).items.filter(
        (i) => i.title === `${TOKEN} akis yorumlu`,
      ).length;
    expect(await countFor(guest)).toBe(0);
    expect(await countFor(member2)).toBe(1);
  });
});

describe("overview and nav-level reads", () => {
  it("overview counts for a guest ignore internal events", async () => {
    await createEvent(member, { title: `${TOKEN} sayac`, startsAt: "2026-03-11T10:00", endsAt: "2026-03-11T11:00", internal: true });
    const g = await getOverviewCounts(guest, { today: "2026-03-10" });
    const m = await getOverviewCounts(member2, { today: "2026-03-10" });
    expect(m.eventsThisWeek).toBeGreaterThan(g.eventsThisWeek);
  });
});

describe("team-only areas and admin actions", () => {
  it("chat is team-only: every guest call is FORBIDDEN and nobody can DM a guest", async () => {
    expect(await code(listChatMessages(guest))).toBe("FORBIDDEN");
    expect(await code(sendChatMessage(guest, { body: "selam" }))).toBe("FORBIDDEN");
    expect(await code(listConversations(guest))).toBe("FORBIDDEN");
    expect(await code(sendChatMessage(member, { body: "selam", peerId: guest.userId }))).toBe("NOT_FOUND");
    expect((await listConversations(member)).map((c) => c.userId)).not.toContain(guest.userId);
    expect(await code(listChatMessages(member))).toBe("OK");
  });

  it("the chat channel is not authorised for guests", async () => {
    const { authorizeChatChannel } = await import("@/server/chat");
    const name = `private-workspace-${owner.workspaceId}`;
    expect(await authorizeChatChannel(guest.userId, name)).toEqual({ allow: false, reason: "NOT_A_MEMBER" });
    expect(await authorizeChatChannel(member.userId, name)).toEqual({ allow: true, workspaceId: owner.workspaceId });
  });

  it("card table, check-ins, reports, trash and the hill chart are team-only", async () => {
    expect(await code(listBoard(guest))).toBe("FORBIDDEN");
    expect(await code(listBoard(member))).toBe("OK");
    expect(await code(listCheckins(guest))).toBe("FORBIDDEN");
    expect(await code(getReports(guest, { today: "2026-03-10" }))).toBe("FORBIDDEN");
    expect(await code(getReports(member, { today: "2026-03-10" }))).toBe("OK");
    expect(await code(listTrash(guest))).toBe("FORBIDDEN");
    expect(await code(restoreTrashItem(guest, { type: "post", id: "x" }))).toBe("FORBIDDEN");
  });

  it("guests are rejected from admin, settings, project and category actions", async () => {
    expect(await code(createProject(guest, { name: "Proje" }))).toBe("FORBIDDEN");
    expect(await code(createCategory(guest, { name: "Kategori", emoji: "🧪" }))).toBe("FORBIDDEN");
    expect(await code(createColumn(guest, { name: "Sutun" }))).toBe("FORBIDDEN");
    expect(await code(renameWorkspace(guest, { name: "Yeni ad" }))).toBe("FORBIDDEN");
    expect(await code(createInvitation(guest, { email: "x@hestia.test", role: "GUEST" }))).toBe("FORBIDDEN");
    expect(await code(createInviteLink(guest, { role: "GUEST" }))).toBe("FORBIDDEN");
    const target = await db.membership.findFirstOrThrow({ where: { userId: member.userId, workspaceId: owner.workspaceId } });
    expect(await code(changeMemberRole(guest, target.id, "ADMIN"))).toBe("FORBIDDEN");
    // A plain member is still refused as before.
    expect(await code(createProject(member, { name: "Proje" }))).toBe("FORBIDDEN");
  });

  it("guests cannot delete other people's content", async () => {
    const post = await createPost(member, { title: `${TOKEN} silinmez`, body: "b" });
    const comment = await createComment(member, post.id, { body: "yorum" });
    expect(await code(deletePost(guest, post.id))).toBe("FORBIDDEN");
    expect(await code(deleteComment(guest, comment.id))).toBe("FORBIDDEN");
    const own = await createComment(guest, post.id, { body: "benim" });
    expect(await code(deleteComment(guest, own.id))).toBe("OK");
  });
});

describe("invitations", () => {
  it("an invitation can grant the guest role and it ends up on the membership", async () => {
    const invitee = await createTestUser();
    const { token, invitation } = await createInvitation(admin, { email: invitee.email, role: "GUEST" });
    expect(invitation.role).toBe("GUEST");
    await acceptInvitation({ userId: invitee.id, email: invitee.email }, token);
    const m = await db.membership.findFirstOrThrow({ where: { userId: invitee.id, workspaceId: owner.workspaceId } });
    expect(m.role).toBe("GUEST");
  });

  it("invite links can grant the guest role; owners still need an owner", async () => {
    const { invitation } = await createInviteLink(admin, { role: "GUEST" });
    expect(invitation.role).toBe("GUEST");
    expect(await code(createInviteLink(admin, { role: "OWNER" }))).toBe("VALIDATION");
    expect(await code(createInvitation(admin, { email: "o@hestia.test", role: "OWNER" }))).toBe("FORBIDDEN");
  });

  it("an admin can turn a member into a guest and back; the guest then loses access to internal items", async () => {
    const { ctx: temp } = await createMember(owner.workspaceId, "MEMBER");
    const post = await createPost(member, { title: `${TOKEN} rol gizli`, body: "b", internal: true });
    await expect(getPostHeader(temp, post.id)).resolves.toBeTruthy();
    const row = await db.membership.findFirstOrThrow({ where: { userId: temp.userId, workspaceId: owner.workspaceId } });
    await changeMemberRole(admin, row.id, "GUEST");
    const asGuest = { ...temp, role: "GUEST" as const };
    await expect(getPostHeader(asGuest, post.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await changeMemberRole(admin, row.id, "MEMBER");
    await expect(getPostHeader({ ...temp, role: "MEMBER" }, post.id)).resolves.toBeTruthy();
  });
});

describe("workspace isolation", () => {
  it("a guest of one workspace gets nothing from another", async () => {
    const foreign = await createPost(otherOwner, { title: `${TOKEN} baska`, body: "b" });
    await expect(getPostHeader(guest, foreign.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
