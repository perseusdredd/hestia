import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { CALENDAR_TODOS_MAX, listMonth } from "@/server/calendar";
import { COMMENTS_SHOWN_MAX, countComments, listComments } from "@/server/comments";
import { getPostHeader } from "@/server/messages";
import { FOLDER_ITEMS_MAX, getFolderPath, listFolderContents } from "@/server/files";
import { DONE_ITEMS_PER_LIST, listTodoLists } from "@/server/todos";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

/**
 * Bounded list views: a workspace with thousands of rows must not send them
 * all to one page. Each cap is checked with real rows, plus tenant isolation
 * of the raw / grouped queries behind it.
 */

let A: TenantContext;
let B: TenantContext;
let member: TenantContext;

beforeAll(async () => {
  const owner = await createTestUser();
  A = (await createTestWorkspace(owner.id)).ctx;
  member = (await createMember(A.workspaceId)).ctx;
  const other = await createTestUser();
  B = (await createTestWorkspace(other.id)).ctx;
});

afterAll(async () => {
  await cleanup();
});

async function seedList(ctx: TenantContext, name: string, open: number, done: number, assigneeId?: string) {
  const list = await db.todoList.create({ data: { workspaceId: ctx.workspaceId, createdById: ctx.userId, name } });
  await db.todoItem.createMany({
    data: Array.from({ length: open + done }, (_, i) => ({
      workspaceId: ctx.workspaceId,
      listId: list.id,
      createdById: ctx.userId,
      assigneeId: assigneeId ?? null,
      title: `${name} ${i}`,
      position: i,
      status: i < done ? ("DONE" as const) : ("OPEN" as const),
      completedAt: i < done ? new Date() : null,
    })),
  });
  return list;
}

describe("listTodoLists caps completed items per list", () => {
  it("loads every open item, the first DONE_ITEMS_PER_LIST done ones, and counts the rest", async () => {
    const big = await seedList(A, "Büyük", 3, DONE_ITEMS_PER_LIST + 20);
    const small = await seedList(A, "Küçük", 2, 1);
    await seedList(B, "Yabancı", 5, 5);

    const lists = await listTodoLists(A);
    expect(lists.map((l) => l.name)).toEqual(["Büyük", "Küçük"]);
    const b = lists.find((l) => l.id === big.id)!;
    expect(b.total).toBe(DONE_ITEMS_PER_LIST + 23);
    expect(b.doneCount).toBe(DONE_ITEMS_PER_LIST + 20);
    expect(b.hiddenDone).toBe(20);
    expect(b.items.filter((i) => !i.done)).toHaveLength(3);
    const doneTitles = b.items.filter((i) => i.done).map((i) => i.title);
    expect(doneTitles).toHaveLength(DONE_ITEMS_PER_LIST);
    // The first ones in list order.
    expect(doneTitles[0]).toBe("Büyük 0");
    expect(doneTitles.at(-1)).toBe(`Büyük ${DONE_ITEMS_PER_LIST - 1}`);
    expect(b.items.every((i) => i.listId === big.id)).toBe(true);

    const s = lists.find((l) => l.id === small.id)!;
    expect(s).toMatchObject({ total: 3, doneCount: 1, hiddenDone: 0 });
    expect(s.items).toHaveLength(3);
  });

  it("with the 'assigned to me' filter nothing counts as capped", async () => {
    const mine = await seedList(member, "Benim", 1, DONE_ITEMS_PER_LIST + 2, member.userId);
    const lists = await listTodoLists(member, { assignedToMe: true });
    const l = lists.find((x) => x.id === mine.id)!;
    expect(l.hiddenDone).toBe(0);
    expect(l.items).toHaveLength(DONE_ITEMS_PER_LIST + 1);
    expect(l.total).toBe(DONE_ITEMS_PER_LIST + 3);
  });
});

describe("countComments", () => {
  it("counts ids beyond the first 500 (chunked) and ignores other workspaces", async () => {
    const list = await seedList(A, "Yorumlu", 600, 0);
    const items = await db.todoItem.findMany({ where: { listId: list.id }, orderBy: { position: "asc" }, select: { id: true } });
    const last = items[599].id;
    await db.comment.create({ data: { workspaceId: A.workspaceId, todoItemId: last, authorId: A.userId, body: "son" } });
    const counts = await countComments(A, "todo", items.map((i) => i.id));
    expect(counts[last]).toBe(1);
    // B cannot count A's comments.
    expect(await countComments(B, "todo", [last])).toEqual({});
  });
});

describe("listFolderContents caps each kind", () => {
  it("returns FOLDER_ITEMS_MAX files by name and flags the rest", async () => {
    const folder = await db.folder.create({ data: { workspaceId: A.workspaceId, createdById: A.userId, name: "Arşiv" } });
    await db.file.createMany({
      data: Array.from({ length: FOLDER_ITEMS_MAX + 3 }, (_, i) => ({
        workspaceId: A.workspaceId,
        folderId: folder.id,
        uploadedById: A.userId,
        name: `dosya-${String(i).padStart(4, "0")}.txt`,
        mimeType: "text/plain",
        size: 1,
        storageKey: `${A.workspaceId}/limits-${folder.id}-${i}`,
      })),
    });
    const res = await listFolderContents(A, folder.id);
    expect(res.files).toHaveLength(FOLDER_ITEMS_MAX);
    expect(res.truncated).toBe(true);
    expect(res.files[0].name).toBe("dosya-0000.txt");
    await expect(listFolderContents(B, folder.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const root = await listFolderContents(A, null);
    expect(root.truncated).toBe(false);
  });

  it("breadcrumbs come from one recursive query and stay in the workspace", async () => {
    let parentId: string | null = null;
    const ids: string[] = [];
    for (const name of ["Bir", "İki", "Üç", "Dört"]) {
      const f: { id: string } = await db.folder.create({
        data: { workspaceId: A.workspaceId, createdById: A.userId, name, parentId },
      });
      ids.push(f.id);
      parentId = f.id;
    }
    const path = await getFolderPath(A, ids[3]);
    expect(path.map((p) => p.name)).toEqual(["Bir", "İki", "Üç", "Dört"]);
    const res = await listFolderContents(A, ids[3]);
    expect(res.breadcrumbs.map((b) => b.id)).toEqual(ids);
    await expect(getFolderPath(B, ids[3])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listMonth", () => {
  it("loads at most CALENDAR_TODOS_MAX due-date markers", async () => {
    const list = await db.todoList.create({ data: { workspaceId: B.workspaceId, createdById: B.userId, name: "Takvim" } });
    await db.todoItem.createMany({
      data: Array.from({ length: CALENDAR_TODOS_MAX + 5 }, (_, i) => ({
        workspaceId: B.workspaceId,
        listId: list.id,
        createdById: B.userId,
        title: `T${i}`,
        position: i,
        dueDate: new Date(Date.UTC(2026, 2, 1 + (i % 28))),
      })),
    });
    const month = await listMonth(B, "2026-03");
    expect(month.todos).toHaveLength(CALENDAR_TODOS_MAX);
    expect((await listMonth(A, "2026-03")).todos).toHaveLength(0);
  });
});

describe("listComments shows the newest COMMENTS_SHOWN_MAX", () => {
  it("returns the newest ones oldest first; counts still see all; other workspaces get NOT_FOUND", async () => {
    const post = await db.post.create({ data: { workspaceId: A.workspaceId, authorId: A.userId, title: "Uzun", body: "x" } });
    const base = Date.UTC(2026, 0, 1);
    await db.comment.createMany({
      data: Array.from({ length: COMMENTS_SHOWN_MAX + 5 }, (_, i) => ({
        workspaceId: A.workspaceId,
        postId: post.id,
        authorId: A.userId,
        body: `y${i}`,
        createdAt: new Date(base + i * 1000),
      })),
    });
    const shown = await listComments(A, { type: "post", id: post.id });
    expect(shown).toHaveLength(COMMENTS_SHOWN_MAX);
    expect(shown[0].body).toBe("y5");
    expect(shown.at(-1)!.body).toBe(`y${COMMENTS_SHOWN_MAX + 4}`);
    expect((await countComments(A, "post", [post.id]))[post.id]).toBe(COMMENTS_SHOWN_MAX + 5);
    await expect(listComments(B, { type: "post", id: post.id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The post page header query does not load comments and stays in the workspace.
    const header = await getPostHeader(A, post.id);
    expect(header.title).toBe("Uzun");
    expect("comments" in header).toBe(false);
    await expect(getPostHeader(B, post.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
