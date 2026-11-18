import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { listActivity } from "@/server/activity";
import { createEvent, deleteEvent, getEvent, listMonth } from "@/server/calendar";
import { createDocument, deleteDocument, getDocument } from "@/server/files";
import { createPost, deletePost, getPost, listPosts } from "@/server/messages";
import { searchWorkspace } from "@/server/search";
import { createTodoItem, createTodoList, deleteTodoItem, deleteTodoList, listTodoLists } from "@/server/todos";
import {
  listTrash,
  purgeExpiredTrash,
  purgeTrashItem,
  restoreTrashItem,
  TRASH_RETENTION_DAYS,
} from "@/server/trash";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

afterAll(async () => {
  await cleanup();
});

describe("trash (soft delete)", () => {
  let owner: TenantContext;
  let alice: TenantContext;
  let bob: TenantContext;
  let other: TenantContext;

  beforeAll(async () => {
    const ownerUser = await createTestUser();
    owner = (await createTestWorkspace(ownerUser.id)).ctx;
    alice = (await createMember(owner.workspaceId, "MEMBER")).ctx;
    bob = (await createMember(owner.workspaceId, "MEMBER")).ctx;
    other = (await createTestWorkspace((await createTestUser()).id)).ctx;
  });

  it("a deleted post leaves lists, detail and search, and comes back on restore", async () => {
    const post = await createPost(alice, { title: "Çöpteki gönderi tmz", body: "x" });
    await deletePost(alice, post.id);

    expect((await listPosts(alice)).items.map((p) => p.id)).not.toContain(post.id);
    await expect(getPost(alice, post.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const found = await searchWorkspace(alice, { q: "Çöpteki gönderi tmz" });
    expect(found.total).toBe(0);
    expect(await db.post.count({ where: { id: post.id } })).toBe(1);

    expect((await listTrash(alice)).map((i) => i.id)).toContain(post.id);
    await restoreTrashItem(alice, { kind: "post", id: post.id });
    expect((await getPost(alice, post.id)).title).toBe("Çöpteki gönderi tmz");
    expect((await listTrash(alice)).map((i) => i.id)).not.toContain(post.id);
    const feed = (await listActivity(alice)).items.filter((i) => i.type === "ITEM_RESTORED");
    expect(feed.map((i) => i.title)).toContain("Çöpteki gönderi tmz");
  });

  it("only the author or an admin sees and restores; other workspaces never do", async () => {
    const post = await createPost(alice, { title: "Alice'in", body: "x" });
    await deletePost(alice, post.id);

    expect((await listTrash(bob)).map((i) => i.id)).not.toContain(post.id);
    expect((await listTrash(owner)).map((i) => i.id)).toContain(post.id);
    await expect(restoreTrashItem(bob, { kind: "post", id: post.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(purgeTrashItem(bob, { kind: "post", id: post.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(restoreTrashItem(other, { kind: "post", id: post.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await restoreTrashItem(owner, { kind: "post", id: post.id });
  });

  it("a live item cannot be restored or purged", async () => {
    const post = await createPost(alice, { title: "Canlı", body: "x" });
    await expect(restoreTrashItem(alice, { kind: "post", id: post.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(purgeTrashItem(alice, { kind: "post", id: post.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(restoreTrashItem(alice, { kind: "nope", id: post.id })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("a deleted list takes its items along; restoring the list restores only those", async () => {
    const list = await createTodoList(alice, { name: "Çöp listesi" });
    const gone = await createTodoItem(alice, list.id, { title: "önce silindi" });
    await createTodoItem(alice, list.id, { title: "listeyle gitti" });
    await deleteTodoItem(alice, gone.id);
    await deleteTodoList(alice, list.id);

    expect((await listTodoLists(alice)).map((l) => l.id)).not.toContain(list.id);
    const trash = await listTrash(alice);
    expect(trash.map((i) => i.id)).toContain(list.id);
    // Items of a trashed list are not roots of their own.
    expect(trash.filter((i) => i.kind === "todoItem").map((i) => i.id)).not.toContain(gone.id);

    await restoreTrashItem(alice, { kind: "todoList", id: list.id });
    const restored = (await listTodoLists(alice)).find((l) => l.id === list.id);
    expect(restored?.items.map((i) => i.title)).toEqual(["listeyle gitti"]);
    // The item deleted earlier is still in the trash, as its own root.
    expect((await listTrash(alice)).filter((i) => i.kind === "todoItem").map((i) => i.id)).toContain(gone.id);
  });

  it("an event leaves the calendar and returns", async () => {
    const ev = await createEvent(alice, { title: "Çöp toplantısı", startsAt: "2026-03-10T10:00", endsAt: "2026-03-10T11:00" });
    await deleteEvent(alice, ev.id);
    await expect(getEvent(alice, ev.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listMonth(alice, "2026-03")).events.map((e) => e.id)).not.toContain(ev.id);
    await restoreTrashItem(alice, { kind: "event", id: ev.id });
    expect((await getEvent(alice, ev.id)).title).toBe("Çöp toplantısı");
  });

  it("a restored document keeps its last-edited date", async () => {
    const doc = await createDocument(alice, { title: "Çöp dokümanı", content: "x" });
    await deleteDocument(alice, doc.id);
    await expect(getDocument(alice, doc.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await restoreTrashItem(alice, { kind: "document", id: doc.id });
    const back = await getDocument(alice, doc.id);
    expect(back.document.updatedAt.getTime()).toBe(doc.updatedAt.getTime());
  });

  it("purgeExpiredTrash removes only rows trashed more than the retention ago", async () => {
    const old = await createPost(alice, { title: "Eski çöp", body: "x" });
    const fresh = await createPost(alice, { title: "Yeni çöp", body: "x" });
    await deletePost(alice, old.id);
    await deletePost(alice, fresh.id);
    // Dated around the year 2000 with a 2000 "now" (like housekeeping.test.ts): the run
    // cannot touch real rows of the shared dev DB.
    const now = new Date("2000-06-01T00:00:00Z");
    const longAgo = new Date(now.getTime() - (TRASH_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    await db.post.update({ where: { id: old.id }, data: { deletedAt: longAgo } });
    await db.post.update({ where: { id: fresh.id }, data: { deletedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } });

    const result = await purgeExpiredTrash(now);
    expect(result.posts).toBeGreaterThanOrEqual(1);
    expect(await db.post.count({ where: { id: old.id } })).toBe(0);
    expect(await db.post.count({ where: { id: fresh.id } })).toBe(1);
  });
});
