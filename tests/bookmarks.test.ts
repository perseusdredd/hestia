import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { isBookmarked, listBookmarks, toggleBookmark } from "@/server/bookmarks";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

let owner: TenantContext;
let member: TenantContext;
let other: TenantContext;
let postId: string;
let draftId: string;
let todoId: string;
let docId: string;
let eventId: string;

beforeAll(async () => {
  const u = await createTestUser();
  ({ ctx: owner } = await createTestWorkspace(u.id));
  ({ ctx: member } = await createMember(owner.workspaceId, "MEMBER"));
  const ub = await createTestUser();
  ({ ctx: other } = await createTestWorkspace(ub.id));

  const w = owner.workspaceId;
  postId = (
    await db.post.create({
      data: { workspaceId: w, authorId: owner.userId, title: "Duyuru", body: "x", publishedAt: new Date() },
    })
  ).id;
  draftId = (
    await db.post.create({ data: { workspaceId: w, authorId: owner.userId, title: "Taslak", body: "x", publishedAt: null } })
  ).id;
  const list = await db.todoList.create({ data: { workspaceId: w, createdById: owner.userId, name: "L" } });
  todoId = (await db.todoItem.create({ data: { listId: list.id, workspaceId: w, createdById: owner.userId, title: "Görev" } })).id;
  docId = (await db.document.create({ data: { workspaceId: w, authorId: owner.userId, title: "Doküman", content: "c" } })).id;
  eventId = (
    await db.event.create({
      data: {
        workspaceId: w,
        createdById: owner.userId,
        title: "Etkinlik",
        startsAt: new Date("2026-12-01T10:00:00Z"),
        endsAt: new Date("2026-12-01T11:00:00Z"),
      },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
});

describe("bookmarks", () => {
  it("toggles on and off for every subject type", async () => {
    for (const s of [
      { type: "post", id: postId },
      { type: "todo", id: todoId },
      { type: "document", id: docId },
      { type: "event", id: eventId },
    ]) {
      expect(await isBookmarked(owner, s)).toBe(false);
      expect((await toggleBookmark(owner, s)).bookmarked).toBe(true);
      expect(await isBookmarked(owner, s)).toBe(true);
      // forcing the same state is idempotent
      expect((await toggleBookmark(owner, s, true)).bookmarked).toBe(true);
      expect((await toggleBookmark(owner, s)).bookmarked).toBe(false);
      expect(await isBookmarked(owner, s)).toBe(false);
    }
  });

  it("rejects subjects from another workspace and bad input", async () => {
    await expect(toggleBookmark(other, { type: "post", id: postId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(toggleBookmark(owner, { type: "nope", id: postId })).rejects.toBeTruthy();
    await expect(toggleBookmark(owner, { type: "post", id: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists newest first with titles and paths, per user", async () => {
    await toggleBookmark(owner, { type: "post", id: postId });
    await new Promise((r) => setTimeout(r, 15));
    await toggleBookmark(owner, { type: "document", id: docId });
    const items = await listBookmarks(owner);
    expect(items.map((i) => [i.type, i.title, i.path])).toEqual([
      ["document", "Doküman", `files/docs/${docId}`],
      ["post", "Duyuru", `messages/${postId}`],
    ]);
    expect(await listBookmarks(member)).toEqual([]);
  });

  it("skips trashed subjects and drafts the user does not own", async () => {
    await toggleBookmark(owner, { type: "event", id: eventId });
    await toggleBookmark(owner, { type: "post", id: draftId });
    expect((await listBookmarks(owner)).map((i) => i.title)).toContain("Taslak");

    await db.event.update({ where: { id: eventId }, data: { deletedAt: new Date() } });
    await db.document.update({ where: { id: docId }, data: { deletedAt: new Date() } });
    expect((await listBookmarks(owner)).map((i) => i.title).sort()).toEqual(["Duyuru", "Taslak"]);

    // another member who somehow holds a bookmark on the owner's draft must not see it
    await db.bookmark.create({
      data: { workspaceId: owner.workspaceId, userId: member.userId, subjectType: "post", subjectId: draftId },
    });
    expect(await listBookmarks(member)).toEqual([]);
  });
});
