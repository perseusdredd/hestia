import { afterAll, describe, expect, it } from "vitest";

import { createEvent, deleteEvent } from "@/server/calendar";
import { getReports, groupOverdueByAssignee, type ReportTodo } from "@/server/reports";
import { createTodoItem, createTodoList, deleteTodoItem, setTodoItemDone } from "@/server/todos";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

afterAll(async () => {
  await cleanup();
});

const today = "2026-11-12";
const now = new Date("2026-11-12T09:00:00Z");

describe("groupOverdueByAssignee", () => {
  const t = (id: string, assigneeId: string | null, assigneeName: string | null): ReportTodo => ({
    id,
    title: id,
    dueDate: "2026-11-01",
    listName: "L",
    assigneeId,
    assigneeName,
  });

  it("puts the biggest group first and unassigned last", () => {
    const groups = groupOverdueByAssignee([t("1", null, null), t("2", "a", "Ayşe"), t("3", "b", "Bora"), t("4", "b", "Bora")]);
    expect(groups.map((g) => [g.assigneeId, g.items.length])).toEqual([["b", 2], ["a", 1], [null, 1]]);
  });
});

describe("getReports", () => {
  it("aggregates overdue, due soon, events and workload, skipping done and trashed rows", async () => {
    const owner = await createTestUser({ name: "Owner" });
    const { ctx } = await createTestWorkspace(owner.id);
    const { user: m1, ctx: c1 } = await createMember(ctx.workspaceId);
    await createMember(ctx.workspaceId); // zero open items
    const list = await createTodoList(ctx, { name: "Liste" });
    const add = (title: string, dueDate: string | undefined, assigneeId?: string) =>
      createTodoItem(ctx, list.id, { title, dueDate, assigneeId });

    await add("Gecikmiş m1", "2026-11-10", m1.id);
    await add("Gecikmiş atanmamış", "2026-11-01");
    const done = await add("Bitti", "2026-11-02", m1.id);
    await setTodoItemDone(ctx, done.id, true);
    const trashed = await add("Çöpte", "2026-11-03", m1.id);
    await deleteTodoItem(ctx, trashed.id);
    await add("Bugün", today, owner.id);
    await add("Yedinci gün", "2026-11-19", m1.id);
    await add("Sekizinci gün", "2026-11-20", m1.id);
    await add("Tarihsiz", undefined, m1.id);

    await createEvent(ctx, { title: "Yakın", startsAt: "2026-11-14T10:00", endsAt: "2026-11-14T11:00" });
    await createEvent(ctx, { title: "Uzak", startsAt: "2026-12-14T10:00", endsAt: "2026-12-14T11:00" });
    const gone = await createEvent(ctx, { title: "Silinmiş", startsAt: "2026-11-15T10:00", endsAt: "2026-11-15T11:00" });
    await deleteEvent(ctx, gone.id);

    const r = await getReports(c1, { today, now });
    expect(r.overdue.total).toBe(2);
    expect(r.overdue.groups.map((g) => [g.assigneeId, g.items.map((i) => i.title)])).toEqual([
      [m1.id, ["Gecikmiş m1"]],
      [null, ["Gecikmiş atanmamış"]],
    ]);
    expect(r.dueSoon.map((i) => i.title)).toEqual(["Bugün", "Yedinci gün"]);
    expect(r.events.map((e) => e.title)).toEqual(["Yakın"]);
    expect(r.workload.map((w) => [w.name, w.openCount])).toEqual([
      [expect.any(String), 4],
      [expect.any(String), 1],
      [expect.any(String), 0],
    ]);
    expect(r.workload[0].userId).toBe(m1.id);
  });

  it("is scoped to the caller's workspace", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const { ctx: ca } = await createTestWorkspace(a.id);
    const { ctx: cb } = await createTestWorkspace(b.id);
    const list = await createTodoList(ca, { name: "Liste" });
    await createTodoItem(ca, list.id, { title: "Gecikmiş", dueDate: "2026-11-01", assigneeId: a.id });
    const r = await getReports(cb, { today, now });
    expect(r.overdue.total).toBe(0);
    expect(r.dueSoon).toEqual([]);
    expect(r.workload.map((w) => w.openCount)).toEqual([0]);
  });

  it("rejects an invalid date", async () => {
    const u = await createTestUser();
    const { ctx } = await createTestWorkspace(u.id);
    await expect(getReports(ctx, { today: "nope" })).rejects.toThrow();
  });
});
