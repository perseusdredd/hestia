import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { ServiceError } from "@/server/errors";
import {
  createCategory,
  DEFAULT_MESSAGE_CATEGORIES,
  deleteCategory,
  ensureDefaultCategories,
  listCategories,
} from "@/server/message-categories";
import { createComment, createPost, deletePost, getPost, listPosts, publishPost, setPostPinned, updatePost } from "@/server/messages";
import { searchWorkspace } from "@/server/search";
import { purgeTrashItem, restoreTrashItem } from "@/server/trash";
import { createWorkspace } from "@/server/workspaces";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

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

const countPostNotifications = (ctx: TenantContext, postId: string) =>
  db.notification.count({ where: { workspaceId: ctx.workspaceId, path: `messages/${postId}` } });

describe("message categories", () => {
  let owner: TenantContext;
  let member: TenantContext;
  let otherOwner: TenantContext;

  beforeAll(async () => {
    const u = await createTestUser();
    owner = (await createTestWorkspace(u.id)).ctx;
    member = (await createMember(owner.workspaceId, "MEMBER")).ctx;
    otherOwner = (await createTestWorkspace((await createTestUser()).id)).ctx;
    await ensureDefaultCategories(db, owner.workspaceId);
    await ensureDefaultCategories(db, owner.workspaceId); // idempotent
  });

  it("seeds the Turkish defaults once", async () => {
    const cats = await listCategories(owner);
    expect(cats.map((c) => c.name)).toEqual(DEFAULT_MESSAGE_CATEGORIES.map((c) => c.name));
    expect(cats[0]).toMatchObject({ name: "Duyuru", emoji: "📢" });
  });

  it("createWorkspace seeds the defaults", async () => {
    const u = await createTestUser();
    const ws = await createWorkspace({ userId: u.id }, { name: "Kategori Testi", slug: `kat-${Date.now().toString(36)}` });
    try {
      expect(await db.messageCategory.count({ where: { workspaceId: ws.id } })).toBe(DEFAULT_MESSAGE_CATEGORIES.length);
    } finally {
      await db.workspace.delete({ where: { id: ws.id } });
      await db.user.delete({ where: { id: u.id } }).catch(() => undefined);
    }
  });

  it("filters the list by category and keeps filtering across pages", async () => {
    const [duyuru, bilgi] = await listCategories(owner);
    for (let i = 0; i < 3; i++) await createPost(owner, { title: `D${i}`, body: "x", categoryId: duyuru.id });
    await createPost(owner, { title: "B0", body: "x", categoryId: bilgi.id });
    await createPost(owner, { title: "none", body: "x" });

    const p1 = await listPosts(owner, { categoryId: duyuru.id, take: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    expect(p1.items.every((p) => p.category?.id === duyuru.id)).toBe(true);
    const p2 = await listPosts(owner, { categoryId: duyuru.id, take: 2, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect(p2.hasMore).toBe(false);
    expect(p2.items[0].category).toMatchObject({ name: "Duyuru", emoji: "📢" });
  });

  it("rejects a category from another workspace and lets admins manage categories", async () => {
    const foreign = await createCategory(otherOwner, { name: "Yabancı", emoji: "🌍" });
    expect(await code(createPost(owner, { title: "t", body: "b", categoryId: foreign.id }))).toBe("VALIDATION");
    expect(await code(createCategory(member, { name: "X", emoji: "x" }))).toBe("FORBIDDEN");

    const mine = await createCategory(owner, { name: "Özel", emoji: "⭐" });
    const post = await createPost(owner, { title: "t", body: "b", categoryId: mine.id });
    await updatePost(owner, post.id, { title: "t", body: "b", categoryId: null });
    expect((await getPost(owner, post.id)).categoryId).toBeNull();
    await updatePost(owner, post.id, { title: "t", body: "b", categoryId: mine.id });
    await updatePost(owner, post.id, { title: "t2", body: "b" }); // undefined keeps it
    expect((await getPost(owner, post.id)).categoryId).toBe(mine.id);
    await deleteCategory(owner, mine.id); // SetNull
    expect((await getPost(owner, post.id)).categoryId).toBeNull();
  });
});

describe("message drafts", () => {
  let author: TenantContext;
  let admin: TenantContext;
  let reader: TenantContext;

  beforeAll(async () => {
    author = (await createTestWorkspace((await createTestUser()).id)).ctx;
    admin = (await createMember(author.workspaceId, "ADMIN")).ctx;
    reader = (await createMember(author.workspaceId, "MEMBER")).ctx;
  });

  it("a draft is visible only to its author and announces nothing", async () => {
    const token = `Taslak${Date.now().toString(36)}`;
    const draft = await createPost(author, { title: token, body: "gizli @taslak", draft: true });
    expect(draft.publishedAt).toBeNull();

    // Author sees it, marked as a draft.
    const mine = await listPosts(author);
    expect(mine.items.find((p) => p.id === draft.id)?.isDraft).toBe(true);
    expect((await listPosts(author, { draftsOnly: true })).items.map((p) => p.id)).toContain(draft.id);
    expect((await listPosts(author, { includeDrafts: false })).items.map((p) => p.id)).not.toContain(draft.id);

    // Nobody else does (not even an admin).
    for (const other of [reader, admin]) {
      expect((await listPosts(other)).items.map((p) => p.id)).not.toContain(draft.id);
      expect((await listPosts(other, { draftsOnly: true })).items).toHaveLength(0);
      expect(await code(getPost(other, draft.id))).toBe("NOT_FOUND");
      expect(await code(updatePost(other, draft.id, { title: "x", body: "y" }))).toBe("NOT_FOUND");
      expect(await code(setPostPinned(other, draft.id, true))).toBe(other === admin ? "NOT_FOUND" : "FORBIDDEN");
      expect(await code(createComment(other, draft.id, { body: "yorum" }))).toBe("NOT_FOUND");
      const found = await searchWorkspace(other, { q: token, types: ["post"] });
      expect(found.groups.flatMap((g) => g.items).some((r) => r.id === draft.id)).toBe(false);
    }
    const own = await searchWorkspace(author, { q: token, types: ["post"] });
    expect(own.groups.flatMap((g) => g.items).some((r) => r.id === draft.id)).toBe(true);

    // No notifications, activity or subscription at draft time, nor on edit or pin.
    await updatePost(author, draft.id, { title: token, body: "yeni metin" });
    await setPostPinned(author, draft.id, true);
    expect(await countPostNotifications(author, draft.id)).toBe(0);
    expect(await db.activity.count({ where: { subjectType: "post", subjectId: draft.id } })).toBe(0);
    expect(await db.subscription.count({ where: { subjectType: "post", subjectId: draft.id } })).toBe(0);
  });

  it("publishing fires notifications, activity and subscription exactly once", async () => {
    const draft = await createPost(author, { title: "Yayına hazır", body: "metin", draft: true });
    const published = await publishPost(author, draft.id);
    expect(published.publishedAt).toBeInstanceOf(Date);

    // Members (admin + reader) are notified once each; the author is not.
    expect(await countPostNotifications(author, draft.id)).toBe(2);
    expect(await db.notification.count({ where: { path: `messages/${draft.id}`, userId: author.userId } })).toBe(0);
    expect(await db.activity.count({ where: { subjectType: "post", subjectId: draft.id, type: "POST_CREATED" } })).toBe(1);
    expect(await db.subscription.count({ where: { subjectType: "post", subjectId: draft.id, userId: author.userId } })).toBe(1);

    // Visible to everyone now, and a second publish does not announce again.
    expect((await listPosts(reader)).items.map((p) => p.id)).toContain(draft.id);
    expect((await getPost(reader, draft.id)).title).toBe("Yayına hazır");
    expect(await code(publishPost(author, draft.id))).toBe("CONFLICT");
    expect(await countPostNotifications(author, draft.id)).toBe(2);
    expect(await db.activity.count({ where: { subjectType: "post", subjectId: draft.id } })).toBe(1);
  });

  it("only the author can publish, and a plain post is announced on create", async () => {
    const draft = await createPost(author, { title: "Başkası yayınlayamaz", body: "x", draft: true });
    expect(await code(publishPost(reader, draft.id))).toBe("NOT_FOUND");

    const live = await createPost(author, { title: "Canlı", body: "x" });
    expect(live.publishedAt).toBeInstanceOf(Date);
    expect(await countPostNotifications(author, live.id)).toBe(2);
    expect(await code(publishPost(author, live.id))).toBe("CONFLICT");
  });

  it("commenting on your own draft leaks nothing to the workspace", async () => {
    const draft = await createPost(author, { title: "Gizli taslak", body: "x", draft: true });
    const c = await createComment(author, draft.id, { body: `@${admin.userId} bak` });

    // No activity row and no notification (neither POST_COMMENT nor MENTION) escapes.
    expect(await db.activity.count({ where: { subjectType: "comment", subjectId: c.id } })).toBe(0);
    expect(await countPostNotifications(author, draft.id)).toBe(0);
    expect(await db.notification.count({ where: { path: `messages/${draft.id}`, userId: admin.userId } })).toBe(0);

    // After publishing, a new comment behaves normally again.
    await publishPost(author, draft.id);
    const c2 = await createComment(reader, draft.id, { body: "artık görünür" });
    expect(await db.activity.count({ where: { subjectType: "comment", subjectId: c2.id, type: "COMMENT_CREATED" } })).toBe(1);
  });

  it("restoring a trashed draft announces nothing and stays author-only", async () => {
    const draft = await createPost(author, { title: "Çöpe giden taslak", body: "x", draft: true });
    await deletePost(author, draft.id);

    // A non-author (even ADMIN) can neither restore nor purge another user's trashed draft.
    expect(await code(restoreTrashItem(admin, { kind: "post", id: draft.id }))).toBe("NOT_FOUND");
    expect(await code(restoreTrashItem(reader, { kind: "post", id: draft.id }))).toBe("NOT_FOUND");
    expect(await code(purgeTrashItem(admin, { kind: "post", id: draft.id }))).toBe("NOT_FOUND");

    // The author restores it; no ITEM_RESTORED row carries the draft title.
    await restoreTrashItem(author, { kind: "post", id: draft.id });
    expect(await db.activity.count({ where: { subjectType: "post", subjectId: draft.id, type: "ITEM_RESTORED" } })).toBe(0);
    expect((await getPost(author, draft.id)).title).toBe("Çöpe giden taslak");
  });
});
