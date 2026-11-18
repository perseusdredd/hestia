import { afterAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { createEvent } from "@/server/calendar";
import { notify } from "@/server/notifications";
import { getOverviewCounts, istanbulWeek } from "@/server/overview";
import { createTodoItem, createTodoList, setTodoItemDone } from "@/server/todos";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

afterAll(async () => {
  await cleanup();
});

async function fresh() {
  const u = await createTestUser();
  const { ctx } = await createTestWorkspace(u.id);
  return ctx;
}

describe("istanbulWeek", () => {
  it("returns Monday..Sunday of the day's week", () => {
    expect(istanbulWeek("2026-11-12")).toEqual({ first: "2026-11-09", last: "2026-11-15" }); // Thursday
    expect(istanbulWeek("2026-11-09")).toEqual({ first: "2026-11-09", last: "2026-11-15" }); // Monday
    expect(istanbulWeek("2026-11-15")).toEqual({ first: "2026-11-09", last: "2026-11-15" }); // Sunday
    expect(istanbulWeek("2027-01-01")).toEqual({ first: "2026-12-28", last: "2027-01-03" });
  });
});

describe("getOverviewCounts", () => {
  const today = "2026-11-12";

  it("counts open, overdue, this week's events and the caller's unread notifications", async () => {
    const ctx = await fresh();
    const { ctx: member } = await createMember(ctx.workspaceId, "MEMBER");
    const list = await createTodoList(ctx, { name: "Liste" });
    await createTodoItem(ctx, list.id, { title: "Tarihsiz" });
    await createTodoItem(ctx, list.id, { title: "Gecikmiş", dueDate: "2026-11-11" });
    await createTodoItem(ctx, list.id, { title: "Bugün", dueDate: today });
    const done = await createTodoItem(ctx, list.id, { title: "Bitti, gecikmiş", dueDate: "2026-11-01" });
    await setTodoItemDone(ctx, done.id, true);

    const ev = (title: string, startsAt: string, endsAt: string) => createEvent(ctx, { title, startsAt, endsAt });
    await ev("Pazartesi sabahı", "2026-11-09T00:30", "2026-11-09T01:00");
    await ev("Pazar akşamı", "2026-11-15T23:00", "2026-11-15T23:30");
    await ev("Önceki haftadan taşan", "2026-11-08T22:00", "2026-11-09T02:00");
    await ev("Önceki hafta", "2026-11-08T10:00", "2026-11-08T11:00");
    await ev("Sonraki hafta", "2026-11-16T00:00", "2026-11-16T01:00");

    // Each createEvent notified the member once; mark one read.
    const memberCounts = await getOverviewCounts(member, { today });
    expect(memberCounts).toEqual({ openTodos: 3, overdueTodos: 1, eventsThisWeek: 3, unreadNotifications: 5 });
    const one = await db.notification.findFirstOrThrow({ where: { userId: member.userId, workspaceId: ctx.workspaceId } });
    await db.notification.update({ where: { id: one.id }, data: { readAt: new Date() } });
    expect((await getOverviewCounts(member, { today })).unreadNotifications).toBe(4);
    // The actor is never notified of their own events.
    expect((await getOverviewCounts(ctx, { today })).unreadNotifications).toBe(0);
  });

  it("counts recurring events with an occurrence this week", async () => {
    const ctx = await fresh();
    const rec = (title: string, startsAt: string, recurrence: string, extra: object = {}) =>
      createEvent(ctx, { title, startsAt, endsAt: startsAt.slice(0, 11) + "11:00", recurrence, ...extra });
    await rec("Haftalık", "2026-10-13T10:00", "WEEKLY"); // Tuesdays
    await rec("Bitmiş seri", "2026-09-01T10:00", "WEEKLY", { recurrenceUntil: "2026-10-01" });
    await rec("Eski günlük", "2020-01-01T10:00", "DAILY");
    expect((await getOverviewCounts(ctx, { today })).eventsThisWeek).toBe(2);
  });

  it("is scoped to ctx's workspace (and user for notifications)", async () => {
    const a = await fresh();
    const b = await fresh();
    const list = await createTodoList(b, { name: "B" });
    await createTodoItem(b, list.id, { title: "B görevi", dueDate: "2026-11-01" });
    await createEvent(b, { title: "B etkinliği", startsAt: "2026-11-12T10:00", endsAt: "2026-11-12T11:00" });
    // Notifications in b's workspace do not count in a.
    const { ctx: bMember } = await createMember(b.workspaceId, "MEMBER");
    await notify(b, { recipientIds: [bMember.userId], type: "MENTION", title: "x", path: "todos" });
    expect(await getOverviewCounts(a, { today })).toEqual({
      openTodos: 0,
      overdueTodos: 0,
      eventsThisWeek: 0,
      unreadNotifications: 0,
    });
    expect((await getOverviewCounts(bMember, { today })).unreadNotifications).toBe(1);
  });

  it("rejects a malformed day", async () => {
    const ctx = await fresh();
    await expect(getOverviewCounts(ctx, { today: "dün" })).rejects.toMatchObject({ code: "VALIDATION" });
    // Default: today in Istanbul.
    await expect(getOverviewCounts(ctx)).resolves.toMatchObject({ openTodos: 0 });
  });
});
