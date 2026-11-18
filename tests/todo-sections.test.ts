import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { getReports } from "@/server/reports";
import {
  createTodoItem,
  createTodoList,
  createTodoSection,
  deleteTodoSection,
  getTodoItemDetail,
  listMyOpenTodos,
  listTodoLists,
  moveTodoItem,
  moveTodoSection,
  renameTodoSection,
  updateTodoItem,
} from "@/server/todos";

import { cleanup, createMember, createTestUser, createTestWorkspace, disconnect } from "./helpers";

let ctxA: TenantContext;
let ctxB: TenantContext;
let memberA: TenantContext;
let memberA2: TenantContext;
let memberA3: TenantContext;
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
  memberA3 = (await createMember(a.workspace.id, "MEMBER")).ctx;
});

afterAll(async () => {
  await cleanup();
  await disconnect();
});

const today = "2026-06-15";

describe("todo sections", () => {
  it("creates sections with dense positions, renames and reorders them", async () => {
    const list = await createTodoList(memberA, { name: "Bölümlü" });
    const s1 = await createTodoSection(memberA, list.id, { name: "  Planlama " });
    const s2 = await createTodoSection(memberA, list.id, { name: "Yapım" });
    const s3 = await createTodoSection(memberA, list.id, { name: "Yayın" });
    expect([s1.position, s2.position, s3.position]).toEqual([0, 1, 2]);
    expect(s1.name).toBe("Planlama");

    await renameTodoSection(memberA, s2.id, { name: "Geliştirme" });
    await moveTodoSection(memberA, s3.id, "up");
    await moveTodoSection(memberA, s3.id, "up");
    const got = (await listTodoLists(memberA)).find((l) => l.id === list.id)!;
    expect(got.sections.map((s) => [s.name, s.position])).toEqual([
      ["Yayın", 0],
      ["Planlama", 1],
      ["Geliştirme", 2],
    ]);
    // Moving past the edge is a no-op and stays dense.
    await moveTodoSection(memberA, s3.id, "up");
    const rows = await db.todoSection.findMany({ where: { listId: list.id }, orderBy: { position: "asc" } });
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it("validates names and permissions", async () => {
    const list = await createTodoList(memberA, { name: "İzin" });
    await expect(createTodoSection(memberA, list.id, { name: "  " })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createTodoSection(memberA2, list.id, { name: "Yetkisiz" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(createTodoSection(ctxA, list.id, { name: "Yönetici" })).resolves.toBeTruthy(); // owner may
  });

  it("deleting a section nulls its items' sectionId but keeps the items, and re-packs positions", async () => {
    const list = await createTodoList(memberA, { name: "Silme" });
    const s1 = await createTodoSection(memberA, list.id, { name: "A" });
    const s2 = await createTodoSection(memberA, list.id, { name: "B" });
    const s3 = await createTodoSection(memberA, list.id, { name: "C" });
    const item = await createTodoItem(memberA, list.id, { title: "Görev", sectionId: s2.id });
    expect(item.sectionId).toBe(s2.id);

    await deleteTodoSection(memberA, s2.id);
    const row = await db.todoItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.sectionId).toBeNull();
    expect(row.deletedAt).toBeNull();
    const rest = await db.todoSection.findMany({ where: { listId: list.id }, orderBy: { position: "asc" } });
    expect(rest.map((r) => [r.id, r.position])).toEqual([
      [s1.id, 0],
      [s3.id, 1],
    ]);
    const dto = (await listTodoLists(memberA)).find((l) => l.id === list.id)!;
    expect(dto.items[0].sectionId).toBeNull();
  });

  it("assigns items to sections of the same list only", async () => {
    const list = await createTodoList(memberA, { name: "Ana" });
    const other = await createTodoList(memberA, { name: "Diğer" });
    const sec = await createTodoSection(memberA, list.id, { name: "Bölüm" });
    const foreign = await createTodoSection(memberA, other.id, { name: "Yabancı" });
    await expect(createTodoItem(memberA, list.id, { title: "X", sectionId: foreign.id })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const item = await createTodoItem(memberA, list.id, { title: "Y" });
    await updateTodoItem(memberA, item.id, { sectionId: sec.id });
    expect((await db.todoItem.findUniqueOrThrow({ where: { id: item.id } })).sectionId).toBe(sec.id);
    await expect(updateTodoItem(memberA, item.id, { sectionId: foreign.id })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await updateTodoItem(memberA, item.id, { sectionId: "" });
    expect((await db.todoItem.findUniqueOrThrow({ where: { id: item.id } })).sectionId).toBeNull();

    // Moving to another list drops the section.
    await updateTodoItem(memberA, item.id, { sectionId: sec.id });
    await moveTodoItem(memberA, item.id, { listId: other.id });
    expect((await db.todoItem.findUniqueOrThrow({ where: { id: item.id } })).sectionId).toBeNull();
  });

  it("moves items up/down only within their own section", async () => {
    const list = await createTodoList(memberA, { name: "Hareket" });
    const sec = await createTodoSection(memberA, list.id, { name: "S" });
    const a = await createTodoItem(memberA, list.id, { title: "a", sectionId: sec.id });
    const b = await createTodoItem(memberA, list.id, { title: "b" });
    const c = await createTodoItem(memberA, list.id, { title: "c", sectionId: sec.id });
    await moveTodoItem(memberA, c.id, { direction: "up" }); // hops over b (other section)
    const rows = await db.todoItem.findMany({ where: { listId: list.id }, orderBy: { position: "asc" } });
    expect(rows.map((r) => r.id)).toEqual([c.id, a.id, b.id]);
  });

  it("is workspace-isolated", async () => {
    const listB = await createTodoList(ctxB, { name: "B" });
    const secB = await createTodoSection(ctxB, listB.id, { name: "B bölümü" });
    await expect(createTodoSection(memberA, listB.id, { name: "X" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(renameTodoSection(memberA, secB.id, { name: "Y" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(moveTodoSection(memberA, secB.id, "down")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteTodoSection(memberA, secB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.todoSection.count({ where: { id: secB.id } })).toBe(1);
    const listA = await createTodoList(memberA, { name: "A" });
    await expect(createTodoItem(memberA, listA.id, { title: "z", sectionId: secB.id })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("start date", () => {
  it("sets and clears startOn without timezone drift", async () => {
    const list = await createTodoList(memberA, { name: "Başlangıç" });
    const item = await createTodoItem(memberA, list.id, { title: "T", startOn: "2026-12-31", dueDate: "2027-01-05" });
    let dto = (await listTodoLists(memberA)).find((l) => l.id === list.id)!.items[0];
    expect(dto.startOn).toBe("2026-12-31");
    expect(dto.dueDate).toBe("2027-01-05");
    await updateTodoItem(memberA, item.id, { startOn: "2027-01-01" });
    dto = (await listTodoLists(memberA)).find((l) => l.id === list.id)!.items[0];
    expect(dto.startOn).toBe("2027-01-01");
    await expect(updateTodoItem(memberA, item.id, { startOn: "2027-02-30" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await updateTodoItem(memberA, item.id, { startOn: "" });
    dto = (await listTodoLists(memberA)).find((l) => l.id === list.id)!.items[0];
    expect(dto.startOn).toBeNull();
    expect(dto.dueDate).toBe("2027-01-05"); // untouched
    const detail = await getTodoItemDetail(memberA, item.id);
    expect(detail.startOn).toBeNull();
  });

  it("items without the new fields keep today's shape", async () => {
    const list = await createTodoList(memberA, { name: "Eski" });
    await createTodoItem(memberA, list.id, { title: "düz" });
    const dto = (await listTodoLists(memberA)).find((l) => l.id === list.id)!;
    expect(dto.sections).toEqual([]);
    expect(dto.items[0]).toMatchObject({ startOn: null, sectionId: null, extraAssignees: [], assigneeId: null });
  });
});

describe("multiple assignees", () => {
  it("adds, replaces and removes extra assignees; the primary assignee stays untouched", async () => {
    const list = await createTodoList(memberA, { name: "Çoklu" });
    const item = await createTodoItem(memberA, list.id, {
      title: "Ortak",
      assigneeId: memberA2.userId,
      extraAssigneeIds: [memberA3.userId, memberA3.userId, memberA2.userId], // dupes + primary ignored
    });
    expect(item.assigneeId).toBe(memberA2.userId);
    let dto = (await listTodoLists(memberA)).find((l) => l.id === list.id)!.items[0];
    expect(dto.assigneeId).toBe(memberA2.userId);
    expect(dto.extraAssignees.map((u) => u.id)).toEqual([memberA3.userId]);

    await updateTodoItem(memberA, item.id, { title: "Ortak 2" }); // extras untouched when not sent
    dto = (await listTodoLists(memberA)).find((l) => l.id === list.id)!.items[0];
    expect(dto.extraAssignees).toHaveLength(1);

    await updateTodoItem(memberA, item.id, { extraAssigneeIds: [memberA.userId] });
    dto = (await listTodoLists(memberA)).find((l) => l.id === list.id)!.items[0];
    expect(dto.extraAssignees.map((u) => u.id)).toEqual([memberA.userId]);

    await updateTodoItem(memberA, item.id, { extraAssigneeIds: [] });
    expect(await db.todoAssignee.count({ where: { todoItemId: item.id } })).toBe(0);
    expect((await db.todoItem.findUniqueOrThrow({ where: { id: item.id } })).assigneeId).toBe(memberA2.userId);
  });

  it("promoting an extra assignee to primary removes the duplicate extra row", async () => {
    const list = await createTodoList(memberA, { name: "Terfi" });
    const item = await createTodoItem(memberA, list.id, { title: "T", extraAssigneeIds: [memberA3.userId] });
    await updateTodoItem(memberA, item.id, { assigneeId: memberA3.userId });
    expect(await db.todoAssignee.count({ where: { todoItemId: item.id } })).toBe(0);
  });

  it("'assigned to me' and my open to-dos include extra-assignee items", async () => {
    const list = await createTodoList(memberA, { name: "Bana" });
    const primary = await createTodoItem(memberA, list.id, { title: "birincil", assigneeId: memberA3.userId });
    const extra = await createTodoItem(memberA, list.id, {
      title: "ek",
      assigneeId: memberA2.userId,
      extraAssigneeIds: [memberA3.userId],
      dueDate: "2026-06-10",
    });
    await createTodoItem(memberA, list.id, { title: "başkası", assigneeId: memberA2.userId });

    const filtered = (await listTodoLists(memberA3, { assignedToMe: true })).find((l) => l.id === list.id)!;
    expect(filtered.items.map((i) => i.id).sort()).toEqual([primary.id, extra.id].sort());

    const mine = await listMyOpenTodos(memberA3, { today });
    const ids = mine.items.map((i) => i.id);
    expect(ids).toContain(primary.id);
    expect(ids).toContain(extra.id);
    expect(mine.items.find((i) => i.id === extra.id)!.overdue).toBe(true);
    expect(mine.total).toBe(ids.length);
  });

  it("counts extra assignees in the report workload", async () => {
    const list = await createTodoList(memberA, { name: "Rapor" });
    const before = (await getReports(ctxA, { today })).workload.find((w) => w.userId === memberA.userId)!.openCount;
    await createTodoItem(memberA, list.id, { title: "r", extraAssigneeIds: [memberA.userId] });
    const after = (await getReports(ctxA, { today })).workload.find((w) => w.userId === memberA.userId)!.openCount;
    expect(after).toBe(before + 1);
  });

  it("only members can be assigned, workspace-isolated", async () => {
    const list = await createTodoList(memberA, { name: "Üye" });
    await expect(createTodoItem(memberA, list.id, { title: "x", extraAssigneeIds: [userB] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const item = await createTodoItem(memberA, list.id, { title: "y" });
    await expect(updateTodoItem(memberA, item.id, { extraAssigneeIds: [userB] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(await db.todoAssignee.count({ where: { todoItemId: item.id } })).toBe(0);
    // Another workspace cannot edit extras of this item.
    await expect(updateTodoItem(ctxB, item.id, { extraAssigneeIds: [userB] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("shows extras on the item detail", async () => {
    const list = await createTodoList(memberA, { name: "Detay" });
    const item = await createTodoItem(memberA, list.id, {
      title: "d",
      extraAssigneeIds: [memberA2.userId],
      startOn: "2026-06-01",
    });
    const detail = await getTodoItemDetail(memberA, item.id);
    expect(detail.extraAssignees.map((u) => u.id)).toEqual([memberA2.userId]);
    expect(detail.startOn).toBe("2026-06-01");
  });
});

describe("start/due validation and extra-assignee update semantics", () => {
  async function err(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return "OK";
    } catch (e) {
      return (e as { code?: string }).code ?? "OTHER";
    }
  }

  it("rejects a start date after the due date (create and edit)", async () => {
    const list = await createTodoList(ctxA, { name: "Tarih kontrolü" });
    expect(await err(createTodoItem(ctxA, list.id, { title: "x", startOn: "2026-12-10", dueDate: "2026-12-01" }))).toBe("VALIDATION");
    const ok = await createTodoItem(ctxA, list.id, { title: "y", startOn: "2026-12-01", dueDate: "2026-12-10" });
    // The edit form always submits both dates together, so an inconsistent pair is caught.
    expect(await err(updateTodoItem(ctxA, ok.id, { startOn: "2026-12-20", dueDate: "2026-12-10" }))).toBe("VALIDATION");
    expect(await err(updateTodoItem(ctxA, ok.id, { startOn: "2026-12-05", dueDate: "2026-12-10" }))).toBe("OK");
  });

  it("updateTodoItem keeps extra assignees when omitted, clears on [], replaces on [id]", async () => {
    const list = await createTodoList(ctxA, { name: "Çoklu atama" });
    const item = await createTodoItem(ctxA, list.id, { title: "görev", extraAssigneeIds: [memberA.userId, memberA2.userId] });
    const extras = () =>
      db.todoAssignee
        .findMany({ where: { todoItemId: item.id }, select: { userId: true } })
        .then((r) => r.map((x) => x.userId).sort());

    expect(await extras()).toEqual([memberA.userId, memberA2.userId].sort());
    // Omitting extraAssigneeIds (e.g. an edit form without the picker) must NOT wipe them.
    await updateTodoItem(ctxA, item.id, { title: "güncel" });
    expect(await extras()).toEqual([memberA.userId, memberA2.userId].sort());
    // A provided list replaces; an empty list clears.
    await updateTodoItem(ctxA, item.id, { extraAssigneeIds: [memberA3.userId] });
    expect(await extras()).toEqual([memberA3.userId]);
    await updateTodoItem(ctxA, item.id, { extraAssigneeIds: [] });
    expect(await extras()).toEqual([]);
  });
});
