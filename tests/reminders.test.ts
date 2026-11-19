import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as cronGet } from "@/app/api/cron/reminders/route";
import { db } from "@/lib/db";
import { parseIstanbulLocal } from "@/lib/istanbul-time";
import type { TenantContext } from "@/lib/tenant-context";
import { createEvent, getEvent, updateEvent } from "@/server/calendar";
import { runDueReminders } from "@/server/reminders";
import {
  createTodoItem,
  createTodoList,
  deleteTodoList,
  getTodoItemDetail,
  listTodoLists,
  setTodoItemDone,
  updateTodoItem,
} from "@/server/todos";

import { cleanup, createMember, createTestUser, createTestWorkspace, disconnect } from "./helpers";

const at = (v: string) => parseIstanbulLocal(v)!;
const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

let owner: TenantContext;
let member: TenantContext; // creator of most items
let other: TenantContext; // bystander / assignee
let guest: TenantContext;
let extra: TenantContext;
let wsId: string;
let outsiderCtx: TenantContext; // another workspace

const REMIND = "2030-03-01T09:00"; // Istanbul wall time
const T = at(REMIND);

async function remindersFor(userId: string, workspaceId = wsId) {
  return db.notification.findMany({ where: { userId, workspaceId, type: "REMINDER" } });
}
async function allReminders() {
  return db.notification.count({ where: { workspaceId: wsId, type: "REMINDER" } });
}
async function newList(ctx: TenantContext, internal = false) {
  return createTodoList(ctx, { name: `L${Math.random()}`, internal });
}
const ev = (ctx: TenantContext, more: Record<string, unknown> = {}) =>
  createEvent(ctx, { title: "Toplantı", startsAt: "2030-03-01T12:00", endsAt: "2030-03-01T13:00", ...more });

beforeAll(async () => {
  const u = await createTestUser();
  const { ctx, workspace } = await createTestWorkspace(u.id);
  owner = ctx;
  wsId = workspace.id;
  member = (await createMember(wsId, "MEMBER")).ctx;
  other = (await createMember(wsId, "MEMBER")).ctx;
  extra = (await createMember(wsId, "MEMBER")).ctx;
  guest = (await createMember(wsId, "GUEST")).ctx;
  const u2 = await createTestUser();
  outsiderCtx = (await createTestWorkspace(u2.id)).ctx;
});

afterAll(async () => {
  await cleanup();
  await disconnect();
});

describe("remindAt input", () => {
  it("stores Istanbul wall time as a UTC instant, exposes it, and null by default", async () => {
    const list = await newList(member);
    const plain = await createTodoItem(member, list.id, { title: "plain" });
    expect(plain.remindAt).toBeNull();
    const withR = await createTodoItem(member, list.id, { title: "r", remindAt: REMIND });
    expect(withR.remindAt?.toISOString()).toBe(T.toISOString());
    expect(withR.reminderSentAt).toBeNull();
    const detail = await getTodoItemDetail(member, withR.id);
    expect(detail.remindAt).toBe(T.toISOString());
    const dto = (await listTodoLists(member)).find((l) => l.id === list.id)!;
    expect(dto.items.find((i) => i.id === withR.id)?.remindAt).toBe(REMIND);
    expect(dto.items.find((i) => i.id === plain.id)?.remindAt).toBe("");
    const e = await ev(member, { remindAt: REMIND });
    expect(e.remindAt?.toISOString()).toBe(T.toISOString());
  });

  it("rejects malformed values", async () => {
    const list = await newList(member);
    await expect(createTodoItem(member, list.id, { title: "x", remindAt: "yarın" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(createTodoItem(member, list.id, { title: "x", remindAt: "2030-02-30T10:00" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(ev(member, { remindAt: "2030-03-01" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("omitted = unchanged, empty string = cleared (to-do and event)", async () => {
    const list = await newList(member);
    const item = await createTodoItem(member, list.id, { title: "x", remindAt: REMIND });
    await updateTodoItem(member, item.id, { title: "y" });
    expect((await db.todoItem.findUniqueOrThrow({ where: { id: item.id } })).remindAt).not.toBeNull();
    await updateTodoItem(member, item.id, { remindAt: "" });
    expect((await db.todoItem.findUniqueOrThrow({ where: { id: item.id } })).remindAt).toBeNull();

    const e = await ev(member, { remindAt: REMIND });
    const base = { title: "Yeni", startsAt: "2030-03-01T12:00", endsAt: "2030-03-01T13:00" };
    await updateEvent(member, e.id, base);
    expect((await getEvent(member, e.id)).remindAt).not.toBeNull();
    await updateEvent(member, e.id, { ...base, remindAt: "" });
    expect((await getEvent(member, e.id)).remindAt).toBeNull();
  });
});

describe("runDueReminders: to-dos", () => {
  it("fires once at/after remindAt, never before, and is idempotent", async () => {
    const list = await newList(member);
    const item = await createTodoItem(member, list.id, { title: "Fatura öde", remindAt: REMIND });
    const before = await allReminders();
    expect(await runDueReminders(minutes(T, -1))).toBe(0);
    expect(await allReminders()).toBe(before);
    expect((await db.todoItem.findUniqueOrThrow({ where: { id: item.id } })).reminderSentAt).toBeNull();

    const fired = await runDueReminders(T); // exactly at remindAt
    expect(fired).toBeGreaterThanOrEqual(1);
    const row = await db.todoItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.reminderSentAt?.toISOString()).toBe(T.toISOString());
    const mine = (await remindersFor(member.userId)).filter((n) => n.path === `todos/${item.id}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: "Görev hatırlatması", body: "Fatura öde", actorId: null, readAt: null });

    const afterFirst = await allReminders();
    expect(await runDueReminders(minutes(T, 60))).toBe(0);
    expect(await allReminders()).toBe(afterFirst);
  });

  it("notifies assignee + extra assignees + creator, nobody else", async () => {
    const list = await newList(member);
    const item = await createTodoItem(member, list.id, {
      title: "Ekip işi",
      assigneeId: other.userId,
      extraAssigneeIds: [extra.userId],
      remindAt: REMIND,
    });
    await runDueReminders(T);
    const path = `todos/${item.id}`;
    const has = async (u: TenantContext) => (await remindersFor(u.userId)).some((n) => n.path === path);
    expect(await has(member)).toBe(true); // creator
    expect(await has(other)).toBe(true); // assignee
    expect(await has(extra)).toBe(true); // extra assignee
    expect(await has(owner)).toBe(false);
    expect(await has(guest)).toBe(false);
  });

  it("when the creator is the assignee, they get exactly one", async () => {
    const list = await newList(member);
    const item = await createTodoItem(member, list.id, { title: "Kendime", assigneeId: member.userId, remindAt: REMIND });
    await runDueReminders(T);
    expect((await remindersFor(member.userId)).filter((n) => n.path === `todos/${item.id}`)).toHaveLength(1);
  });

  it("does not remind about completed to-dos (stamps them as handled)", async () => {
    const list = await newList(member);
    const item = await createTodoItem(member, list.id, { title: "Bitti", remindAt: REMIND });
    await setTodoItemDone(member, item.id, true);
    await runDueReminders(T);
    expect((await remindersFor(member.userId)).some((n) => n.path === `todos/${item.id}`)).toBe(false);
    expect((await db.todoItem.findUniqueOrThrow({ where: { id: item.id } })).reminderSentAt).not.toBeNull();
  });

  it("skips trashed items and items of a trashed list (and does not stamp them)", async () => {
    const list = await newList(member);
    const gone = await createTodoItem(member, list.id, { title: "Silinen", remindAt: REMIND });
    await deleteTodoList(member, list.id);
    await runDueReminders(T);
    expect((await remindersFor(member.userId)).some((n) => n.path === `todos/${gone.id}`)).toBe(false);
    expect((await db.todoItem.findUniqueOrThrow({ where: { id: gone.id } })).reminderSentAt).toBeNull();

    const list2 = await newList(member);
    const soft = await createTodoItem(member, list2.id, { title: "Soft", remindAt: REMIND });
    await db.todoItem.update({ where: { id: soft.id }, data: { deletedAt: new Date() } });
    await runDueReminders(T);
    expect((await remindersFor(member.userId)).some((n) => n.path === `todos/${soft.id}`)).toBe(false);
  });

  it("team-only to-dos never reach a guest, even an assigned one; public ones do", async () => {
    const internalList = await newList(owner, true);
    const hidden = await createTodoItem(owner, internalList.id, {
      title: "Gizli",
      assigneeId: guest.userId,
      remindAt: REMIND,
    });
    const publicList = await newList(owner, false);
    const shown = await createTodoItem(owner, publicList.id, {
      title: "Açık",
      assigneeId: guest.userId,
      remindAt: REMIND,
    });
    await runDueReminders(T);
    const paths = (await remindersFor(guest.userId)).map((n) => n.path);
    expect(paths).not.toContain(`todos/${hidden.id}`);
    expect(paths).toContain(`todos/${shown.id}`);
    // The creator (owner) still hears about the internal one.
    expect((await remindersFor(owner.userId)).some((n) => n.path === `todos/${hidden.id}`)).toBe(true);
  });

  it("clearing and rescheduling re-arms the reminder", async () => {
    const list = await newList(member);
    const item = await createTodoItem(member, list.id, { title: "Tekrar", remindAt: REMIND });
    const path = `todos/${item.id}`;
    const count = async () => (await remindersFor(member.userId)).filter((n) => n.path === path).length;
    await runDueReminders(T);
    expect(await count()).toBe(1);

    // Same time again: stays sent.
    await updateTodoItem(member, item.id, { remindAt: REMIND });
    await runDueReminders(minutes(T, 5));
    expect(await count()).toBe(1);

    // Rescheduled to a later time: re-armed, not due yet, then fires once.
    await updateTodoItem(member, item.id, { remindAt: "2030-03-02T09:00" });
    expect((await db.todoItem.findUniqueOrThrow({ where: { id: item.id } })).reminderSentAt).toBeNull();
    await runDueReminders(minutes(T, 60));
    expect(await count()).toBe(1);
    await runDueReminders(at("2030-03-02T09:00"));
    expect(await count()).toBe(2);
    await runDueReminders(at("2030-03-03T09:00"));
    expect(await count()).toBe(2);

    // Clearing resets the stamp; setting again re-arms.
    await updateTodoItem(member, item.id, { remindAt: "" });
    const cleared = await db.todoItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(cleared).toMatchObject({ remindAt: null, reminderSentAt: null });
    await updateTodoItem(member, item.id, { remindAt: "2030-03-04T09:00" });
    await runDueReminders(at("2030-03-04T09:00"));
    expect(await count()).toBe(3);
  });

  it("a muted REMINDER type is honoured for that recipient only", async () => {
    const muter = await createMember(wsId, "MEMBER");
    await db.notificationPreference.create({
      data: { workspaceId: wsId, userId: muter.ctx.userId, mutedTypes: ["REMINDER"] },
    });
    const list = await newList(member);
    const item = await createTodoItem(member, list.id, { title: "Sessiz", assigneeId: muter.ctx.userId, remindAt: REMIND });
    await runDueReminders(T);
    expect((await remindersFor(muter.ctx.userId)).some((n) => n.path === `todos/${item.id}`)).toBe(false);
    expect((await remindersFor(member.userId)).some((n) => n.path === `todos/${item.id}`)).toBe(true);
  });
});

describe("runDueReminders: events", () => {
  it("notifies creator + invitees only; fires once", async () => {
    const e = await ev(member, { remindAt: REMIND, inviteeIds: [other.userId] });
    const path = `calendar/${e.id}`;
    const before = await allReminders();
    expect(await runDueReminders(minutes(T, -1))).toBe(0);
    expect(await allReminders()).toBe(before);

    await runDueReminders(T);
    const has = async (u: TenantContext) => (await remindersFor(u.userId)).filter((n) => n.path === path).length;
    expect(await has(member)).toBe(1);
    expect(await has(other)).toBe(1);
    expect(await has(extra)).toBe(0);
    expect(await has(owner)).toBe(0);
    const n = (await remindersFor(other.userId)).find((x) => x.path === path)!;
    expect(n).toMatchObject({ title: "Etkinlik hatırlatması", body: "Toplantı", actorId: null });
    expect((await db.event.findUniqueOrThrow({ where: { id: e.id } })).reminderSentAt).not.toBeNull();

    await runDueReminders(minutes(T, 120));
    expect(await has(member)).toBe(1);
    expect(await has(other)).toBe(1);
  });

  it("team-only events skip invited guests; public events reach them", async () => {
    const hidden = await ev(owner, { remindAt: REMIND, internal: true, inviteeIds: [guest.userId, other.userId] });
    const shown = await ev(owner, { remindAt: REMIND, inviteeIds: [guest.userId] });
    await runDueReminders(T);
    const gPaths = (await remindersFor(guest.userId)).map((n) => n.path);
    expect(gPaths).not.toContain(`calendar/${hidden.id}`);
    expect(gPaths).toContain(`calendar/${shown.id}`);
    expect((await remindersFor(other.userId)).some((n) => n.path === `calendar/${hidden.id}`)).toBe(true);
  });

  it("skips trashed events", async () => {
    const e = await ev(member, { remindAt: REMIND });
    await db.event.update({ where: { id: e.id }, data: { deletedAt: new Date() } });
    await runDueReminders(T);
    expect((await remindersFor(member.userId)).some((n) => n.path === `calendar/${e.id}`)).toBe(false);
    expect((await db.event.findUniqueOrThrow({ where: { id: e.id } })).reminderSentAt).toBeNull();
  });

  it("clearing and rescheduling re-arms", async () => {
    const e = await ev(member, { remindAt: REMIND });
    const path = `calendar/${e.id}`;
    const count = async () => (await remindersFor(member.userId)).filter((n) => n.path === path).length;
    const base = { title: "Toplantı", startsAt: "2030-03-01T12:00", endsAt: "2030-03-01T13:00" };
    await runDueReminders(T);
    expect(await count()).toBe(1);

    await updateEvent(member, e.id, { ...base, remindAt: REMIND }); // unchanged
    await runDueReminders(minutes(T, 10));
    expect(await count()).toBe(1);

    await updateEvent(member, e.id, { ...base, remindAt: "2030-03-01T10:30" }); // moved
    expect((await getEvent(member, e.id)).reminderSentAt).toBeNull();
    await runDueReminders(at("2030-03-01T10:30"));
    expect(await count()).toBe(2);

    await updateEvent(member, e.id, { ...base, remindAt: "" });
    expect(await db.event.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({
      remindAt: null,
      reminderSentAt: null,
    });
    await runDueReminders(at("2031-01-01T00:00"));
    expect(await count()).toBe(2);
  });

  it("an update without remindAt leaves a sent reminder sent", async () => {
    const e = await ev(member, { remindAt: REMIND });
    await runDueReminders(T);
    await updateEvent(member, e.id, { title: "Başka", startsAt: "2030-03-01T12:00", endsAt: "2030-03-01T13:00" });
    expect((await getEvent(member, e.id)).reminderSentAt).not.toBeNull();
  });
});

describe("workspace scoping and return value", () => {
  it("items notify only members of their own workspace", async () => {
    const list = await newList(outsiderCtx);
    const item = await createTodoItem(outsiderCtx, list.id, { title: "Dışarıda", remindAt: REMIND });
    await runDueReminders(T);
    expect(await db.notification.count({ where: { userId: member.userId, path: `todos/${item.id}` } })).toBe(0);
    const own = await db.notification.findMany({ where: { userId: outsiderCtx.userId, path: `todos/${item.id}` } });
    expect(own).toHaveLength(1);
    expect(own[0].workspaceId).toBe(outsiderCtx.workspaceId);
  });

  it("an assignee who left the workspace is not notified", async () => {
    const gone = await createMember(wsId, "MEMBER");
    const list = await newList(owner);
    const item = await createTodoItem(owner, list.id, { title: "Ayrılan", assigneeId: gone.ctx.userId, remindAt: REMIND });
    await db.membership.deleteMany({ where: { workspaceId: wsId, userId: gone.ctx.userId } });
    await runDueReminders(T);
    expect((await remindersFor(gone.ctx.userId)).some((n) => n.path === `todos/${item.id}`)).toBe(false);
  });

  it("returns the number of fired items (to-dos + events)", async () => {
    const w = await createTestWorkspace((await createTestUser()).id);
    const l = await createTodoList(w.ctx, { name: "Sayaç" });
    const when = "2031-06-01T08:00";
    await createTodoItem(w.ctx, l.id, { title: "a", remindAt: when });
    await createTodoItem(w.ctx, l.id, { title: "b", remindAt: when });
    await createEvent(w.ctx, { title: "c", startsAt: "2031-06-02T08:00", endsAt: "2031-06-02T09:00", remindAt: when });
    await createTodoItem(w.ctx, l.id, { title: "no reminder" });
    const fired = await runDueReminders(at(when));
    expect(fired).toBeGreaterThanOrEqual(3);
    expect(await db.notification.count({ where: { workspaceId: w.workspace.id, type: "REMINDER" } })).toBe(3);
    expect(await runDueReminders(at(when))).toBe(0);
  });
});

describe("cron route", () => {
  const OLD = process.env.CRON_SECRET;
  afterAll(() => {
    if (OLD === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = OLD;
  });
  const call = (auth?: string) =>
    cronGet(new Request("http://x/api/cron/reminders", { headers: auth ? { authorization: auth } : {} }));

  it("503 without CRON_SECRET, 401 with a wrong one, 200 with the right one", async () => {
    delete process.env.CRON_SECRET;
    expect((await call("Bearer s3cret")).status).toBe(503);
    process.env.CRON_SECRET = "s3cret";
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    const ok = await call("Bearer s3cret");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, fired: expect.any(Number) });
  });
});
