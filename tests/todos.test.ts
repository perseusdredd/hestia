import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import {
  createTodoItem,
  createTodoList,
  deleteTodoItem,
  deleteTodoList,
  listTodoLists,
  moveTodoItem,
  moveTodoList,
  setTodoItemDone,
  updateTodoItem,
  updateTodoList,
} from "@/server/todos";

import {
  cleanup,
  createMember,
  createTestUser,
  createTestWorkspace,
  disconnect,
} from "./helpers";

let ctxA: TenantContext; // owner of A
let ctxB: TenantContext; // owner of B
let memberA: TenantContext;
let memberA2: TenantContext;
let adminA: TenantContext;
let userB: string;

beforeAll(async () => {
  const ownerA = await createTestUser();
  const ownerB = await createTestUser();
  userB = ownerB.id;
  const a = await createTestWorkspace(ownerA.id);
  const b = await createTestWorkspace(ownerB.id);
  ctxA = a.ctx;
  ctxB = b.ctx;
  memberA = (await createMember(a.workspace.id, "MEMBER")).ctx;
  memberA2 = (await createMember(a.workspace.id, "MEMBER")).ctx;
  adminA = (await createMember(a.workspace.id, "ADMIN")).ctx;
});

afterAll(async () => {
  await cleanup();
  await disconnect();
});

describe("lists and items", () => {
  it("creates lists and assigns increasing item positions", async () => {
    const list = await createTodoList(memberA, { name: "  Lansman  ", description: "" });
    expect(list.name).toBe("Lansman");
    expect(list.description).toBeNull();

    const i1 = await createTodoItem(memberA, list.id, { title: "Birinci" });
    const i2 = await createTodoItem(memberA, list.id, { title: "İkinci" });
    const i3 = await createTodoItem(memberA, list.id, { title: "Üçüncü" });
    expect([i1.position, i2.position, i3.position]).toEqual([0, 1, 2]);
  });

  it("rejects empty titles with a field error", async () => {
    const list = await createTodoList(memberA, { name: "Doğrulama" });
    await expect(createTodoItem(memberA, list.id, { title: "   " })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(createTodoList(memberA, { name: "" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("toggles done and sets/clears completedAt", async () => {
    const list = await createTodoList(memberA, { name: "Toggle" });
    const item = await createTodoItem(memberA, list.id, { title: "Yap" });
    await setTodoItemDone(memberA2, item.id, true); // any member may toggle
    let row = await db.todoItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.status).toBe("DONE");
    expect(row.completedAt).toBeInstanceOf(Date);
    await setTodoItemDone(memberA, item.id, false);
    row = await db.todoItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.status).toBe("OPEN");
    expect(row.completedAt).toBeNull();
  });

  it("stores date-only due dates without timezone drift", async () => {
    const list = await createTodoList(memberA, { name: "Tarih" });
    const item = await createTodoItem(memberA, list.id, { title: "Teslim", dueDate: "2026-12-31" });
    await updateTodoItem(memberA, item.id, { dueDate: "2027-01-01" });
    const lists = await listTodoLists(memberA);
    const found = lists.find((l) => l.id === list.id)!.items[0];
    expect(found.dueDate).toBe("2027-01-01");
    await expect(updateTodoItem(memberA, item.id, { dueDate: "2027-02-30" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await updateTodoItem(memberA, item.id, { dueDate: "" });
    const again = await listTodoLists(memberA);
    expect(again.find((l) => l.id === list.id)!.items[0].dueDate).toBeNull();
  });

  it("reports progress and filters to my assigned items", async () => {
    const list = await createTodoList(memberA, { name: "İlerleme" });
    const mine = await createTodoItem(memberA, list.id, { title: "Benim", assigneeId: memberA2.userId });
    const other = await createTodoItem(memberA, list.id, { title: "Diğer" });
    await setTodoItemDone(memberA, other.id, true);

    const all = (await listTodoLists(memberA2)).find((l) => l.id === list.id)!;
    expect(all.total).toBe(2);
    expect(all.doneCount).toBe(1);

    const filtered = (await listTodoLists(memberA2, { assignedToMe: true })).find(
      (l) => l.id === list.id,
    )!;
    expect(filtered.items.map((i) => i.id)).toEqual([mine.id]);
    expect(filtered.total).toBe(2);

    const none = await listTodoLists(adminA, { assignedToMe: true });
    expect(none.find((l) => l.id === list.id)).toBeUndefined();
  });

  it("rejects an assignee who is not a member of the workspace", async () => {
    const list = await createTodoList(memberA, { name: "Atama" });
    await expect(
      createTodoItem(memberA, list.id, { title: "X", assigneeId: userB }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const item = await createTodoItem(memberA, list.id, { title: "Y" });
    await expect(updateTodoItem(memberA, item.id, { assigneeId: userB })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await updateTodoItem(memberA, item.id, { assigneeId: memberA2.userId });
    const row = await db.todoItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.assigneeId).toBe(memberA2.userId);
  });
});

describe("tenant isolation", () => {
  it("workspace A cannot read, update, toggle or delete B's rows", async () => {
    const listB = await createTodoList(ctxB, { name: "B listesi" });
    const itemB = await createTodoItem(ctxB, listB.id, { title: "B görevi" });

    const seen = await listTodoLists(ctxA);
    expect(seen.some((l) => l.id === listB.id)).toBe(false);

    await expect(updateTodoList(ctxA, listB.id, { name: "ele geçirildi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(updateTodoItem(ctxA, itemB.id, { title: "ele geçirildi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(setTodoItemDone(ctxA, itemB.id, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteTodoItem(ctxA, itemB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteTodoList(ctxA, listB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const itemRow = await db.todoItem.findUniqueOrThrow({ where: { id: itemB.id } });
    expect(itemRow.title).toBe("B görevi");
    expect(itemRow.status).toBe("OPEN");
    expect((await db.todoList.findUniqueOrThrow({ where: { id: listB.id } })).name).toBe("B listesi");
  });

  it("cannot attach an item to another workspace's list", async () => {
    const listB = await createTodoList(ctxB, { name: "B ebeveyn" });
    await expect(createTodoItem(ctxA, listB.id, { title: "sızma" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await db.todoItem.count({ where: { listId: listB.id } })).toBe(0);
  });
});

describe("permissions", () => {
  it("a member cannot edit or delete another member's content; admin and author can", async () => {
    const list = await createTodoList(memberA, { name: "Yetki" });
    const item = await createTodoItem(memberA, list.id, { title: "Benim" });

    await expect(updateTodoList(memberA2, list.id, { name: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(deleteTodoList(memberA2, list.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateTodoItem(memberA2, item.id, { title: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(deleteTodoItem(memberA2, item.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const view = (await listTodoLists(memberA2)).find((l) => l.id === list.id)!;
    expect(view.canEdit).toBe(false);
    expect(view.items[0].canEdit).toBe(false);

    await updateTodoItem(adminA, item.id, { title: "Yönetici düzenledi" });
    await updateTodoList(adminA, list.id, { name: "Yönetici adı" });
    await updateTodoItem(memberA, item.id, { title: "Yazar düzenledi" });

    await deleteTodoItem(adminA, item.id);
    await deleteTodoList(adminA, list.id);
    expect(await db.todoList.count({ where: { id: list.id } })).toBe(0);
  });

  it("deleting a list removes its items", async () => {
    const list = await createTodoList(memberA, { name: "Silinecek" });
    await createTodoItem(memberA, list.id, { title: "a" });
    await deleteTodoList(memberA, list.id);
    expect(await db.todoItem.count({ where: { listId: list.id } })).toBe(0);
  });
});

describe("reordering", () => {
  async function itemTitles(ctx: TenantContext, listId: string) {
    const lists = await listTodoLists(ctx);
    return lists.find((l) => l.id === listId)!.items.map((i) => i.title);
  }
  async function positions(listId: string) {
    const rows = await db.todoItem.findMany({ where: { listId }, orderBy: { position: "asc" } });
    return rows.map((r) => r.position);
  }
  async function seed(ctx: TenantContext, titles: string[]) {
    const list = await createTodoList(ctx, { name: `L-${titles.join("")}` });
    const items = [];
    for (const t of titles) items.push(await createTodoItem(ctx, list.id, { title: t }));
    return { list, items };
  }

  it("moves an item up and down and keeps positions dense", async () => {
    const { list, items } = await seed(memberA, ["a", "b", "c"]);
    await moveTodoItem(memberA, items[2].id, { direction: "up" });
    expect(await itemTitles(memberA, list.id)).toEqual(["a", "c", "b"]);
    await moveTodoItem(memberA, items[0].id, { direction: "down" });
    expect(await itemTitles(memberA, list.id)).toEqual(["c", "a", "b"]);
    expect(await positions(list.id)).toEqual([0, 1, 2]);
    // at the ends: no-op
    await moveTodoItem(memberA, items[1].id, { direction: "down" });
    await moveTodoItem(memberA, items[2].id, { direction: "up" });
    expect(await itemTitles(memberA, list.id)).toEqual(["c", "a", "b"]);
  });

  it("repairs gaps left by deletes when moving", async () => {
    const { list, items } = await seed(memberA, ["a", "b", "c", "d"]);
    await deleteTodoItem(memberA, items[1].id);
    await moveTodoItem(memberA, items[3].id, { direction: "up" });
    expect(await itemTitles(memberA, list.id)).toEqual(["a", "d", "c"]);
    expect(await positions(list.id)).toEqual([0, 1, 2]);
  });

  it("hops over items with the other completion state", async () => {
    const { list, items } = await seed(memberA, ["a", "b", "c"]);
    await setTodoItemDone(memberA, items[1].id, true);
    await moveTodoItem(memberA, items[2].id, { direction: "up" });
    expect(await itemTitles(memberA, list.id)).toEqual(["c", "a", "b"]);
  });

  it("concurrent moves never leave duplicates or gaps", async () => {
    const { list, items } = await seed(memberA, ["a", "b", "c", "d", "e"]);
    await Promise.all([
      moveTodoItem(memberA, items[4].id, { direction: "up" }),
      moveTodoItem(memberA, items[3].id, { direction: "up" }),
      moveTodoItem(memberA, items[0].id, { direction: "down" }),
      moveTodoItem(memberA, items[2].id, { direction: "down" }),
    ]);
    expect(await positions(list.id)).toEqual([0, 1, 2, 3, 4]);
    expect([...(await itemTitles(memberA, list.id))].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("moves an item to another list of the same workspace (appended, both lists dense)", async () => {
    const src = await seed(memberA, ["a", "b", "c"]);
    const dst = await seed(memberA, ["x", "y"]);
    await moveTodoItem(memberA, src.items[1].id, { listId: dst.list.id });
    expect(await itemTitles(memberA, src.list.id)).toEqual(["a", "c"]);
    expect(await itemTitles(memberA, dst.list.id)).toEqual(["x", "y", "b"]);
    expect(await positions(src.list.id)).toEqual([0, 1]);
    expect(await positions(dst.list.id)).toEqual([0, 1, 2]);
    // moving to the current list is a no-op
    await moveTodoItem(memberA, src.items[0].id, { listId: src.list.id });
    expect(await itemTitles(memberA, src.list.id)).toEqual(["a", "c"]);
  });

  it("moves lists up and down", async () => {
    const ws = await createTestWorkspace((await createTestUser()).id);
    const l1 = await createTodoList(ws.ctx, { name: "one" });
    await createTodoList(ws.ctx, { name: "two" });
    const l3 = await createTodoList(ws.ctx, { name: "three" });
    const names = async () => (await listTodoLists(ws.ctx)).map((l) => l.name);
    await moveTodoList(ws.ctx, l3.id, "up");
    expect(await names()).toEqual(["one", "three", "two"]);
    await moveTodoList(ws.ctx, l1.id, "down");
    expect(await names()).toEqual(["three", "one", "two"]);
    await moveTodoList(ws.ctx, l3.id, "up"); // already first
    expect(await names()).toEqual(["three", "one", "two"]);
    const rows = await db.todoList.findMany({
      where: { workspaceId: ws.ctx.workspaceId },
      orderBy: { position: "asc" },
    });
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it("concurrent list creates (even in an empty workspace) get distinct, dense positions", async () => {
    const ws = await createTestWorkspace((await createTestUser()).id);
    const other = (await createMember(ws.workspace.id, "MEMBER")).ctx;
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => createTodoList(i % 2 ? other : ws.ctx, { name: `eş-${i}` })),
    );
    const rows = await db.todoList.findMany({
      where: { workspaceId: ws.ctx.workspaceId },
      orderBy: { position: "asc" },
    });
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("validates input", async () => {
    const { items } = await seed(memberA, ["a"]);
    await expect(moveTodoItem(memberA, items[0].id, {})).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(moveTodoItem(memberA, items[0].id, { direction: "left" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(moveTodoList(memberA, items[0].listId, "sideways")).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  describe("tenant isolation", () => {
    it("cannot move an item into another workspace's list", async () => {
      const mine = await seed(memberA, ["a", "b"]);
      const foreign = await seed(ctxB, ["x"]);
      await expect(
        moveTodoItem(memberA, mine.items[0].id, { listId: foreign.list.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await itemTitles(memberA, mine.list.id)).toEqual(["a", "b"]);
      expect(await itemTitles(ctxB, foreign.list.id)).toEqual(["x"]);
    });

    it("cannot reorder another workspace's item or list", async () => {
      const foreign = await seed(ctxB, ["x", "y"]);
      await expect(
        moveTodoItem(ctxA, foreign.items[1].id, { direction: "up" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(moveTodoList(ctxA, foreign.list.id, "up")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      const mine = await seed(ctxA, ["q"]);
      await expect(
        moveTodoItem(ctxB, mine.items[0].id, { listId: foreign.list.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await itemTitles(ctxB, foreign.list.id)).toEqual(["x", "y"]);
    });
  });

  describe("permissions", () => {
    it("members cannot move others' items or lists; authors, admins and owners can", async () => {
      const { list, items } = await seed(memberA, ["a", "b"]);
      await expect(
        moveTodoItem(memberA2, items[1].id, { direction: "up" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(moveTodoList(memberA2, list.id, "up")).rejects.toMatchObject({ code: "FORBIDDEN" });
      const target = await seed(memberA2, ["z"]);
      await expect(
        moveTodoItem(memberA2, items[0].id, { listId: target.list.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      await moveTodoItem(adminA, items[1].id, { direction: "up" });
      expect(await itemTitles(memberA, list.id)).toEqual(["b", "a"]);
      await moveTodoItem(ctxA, items[1].id, { direction: "down" });
      expect(await itemTitles(memberA, list.id)).toEqual(["a", "b"]);
      await moveTodoList(adminA, list.id, "up");
      await moveTodoList(memberA, list.id, "down");
    });
  });
});
