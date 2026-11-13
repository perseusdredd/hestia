import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import {
  buildMonthGrid,
  eventDayKeys,
  istanbulDayEnd,
  istanbulDayKey,
  istanbulDayStart,
  parseIstanbulLocal,
  toIstanbulInputValue,
} from "@/lib/istanbul-time";
import {
  createEvent,
  deleteEvent,
  getEvent,
  listMonth,
  normalizeEventInput,
  updateEvent,
} from "@/server/calendar";

import { cleanup, createMember, createTestUser, createTestWorkspace, disconnect } from "./helpers";

let ctxA: TenantContext;
let ctxB: TenantContext;
let memberA: TenantContext;
let memberA2: TenantContext;
let adminA: TenantContext;

const base = { title: "Toplanti", startsAt: "2026-03-10T10:00", endsAt: "2026-03-10T11:00" };

beforeAll(async () => {
  const a = await createTestWorkspace((await createTestUser()).id);
  const b = await createTestWorkspace((await createTestUser()).id);
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

describe("Istanbul time helpers", () => {
  it("converts wall time to UTC (+3)", () => {
    expect(parseIstanbulLocal("2026-03-10T10:00")?.toISOString()).toBe("2026-03-10T07:00:00.000Z");
    expect(parseIstanbulLocal("2026-03-10T01:30")?.toISOString()).toBe("2026-03-09T22:30:00.000Z");
    expect(parseIstanbulLocal("2026-03-10")?.toISOString()).toBe("2026-03-09T21:00:00.000Z");
  });
  it("rejects invalid values", () => {
    expect(parseIstanbulLocal("2026-02-31")).toBeNull();
    expect(parseIstanbulLocal("2026-03-10T25:00")).toBeNull();
    expect(parseIstanbulLocal("garbage")).toBeNull();
  });
  it("round-trips and computes day bounds", () => {
    const d = parseIstanbulLocal("2026-07-01T23:45")!;
    expect(toIstanbulInputValue(d, true)).toBe("2026-07-01T23:45");
    expect(istanbulDayKey(new Date("2026-03-09T21:00:00.000Z"))).toBe("2026-03-10");
    expect(istanbulDayStart("2026-03-10").toISOString()).toBe("2026-03-09T21:00:00.000Z");
    expect(istanbulDayEnd("2026-03-10").toISOString()).toBe("2026-03-10T20:59:59.999Z");
  });
  it("builds a Monday-first grid", () => {
    const g = buildMonthGrid("2026-03");
    expect(g.firstKey).toBe("2026-02-23");
    expect(g.lastKey).toBe("2026-04-05");
    expect(g.days.length % 7).toBe(0);
  });
  it("lists every day of multi-day events", () => {
    const s = parseIstanbulLocal("2026-03-10T22:00")!;
    const e = parseIstanbulLocal("2026-03-12T09:00")!;
    expect(eventDayKeys(s, e)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
    const midnight = parseIstanbulLocal("2026-03-11T00:00")!;
    expect(eventDayKeys(s, midnight)).toEqual(["2026-03-10"]);
  });
});

describe("normalizeEventInput", () => {
  it("rejects end before start", () => {
    expect(() =>
      normalizeEventInput({ ...base, startsAt: "2026-03-10T12:00", endsAt: "2026-03-10T11:00" }),
    ).toThrow(/önce/);
  });
  it("accepts end == start", () => {
    expect(() => normalizeEventInput({ ...base, endsAt: base.startsAt })).not.toThrow();
  });
  it("requires a title", () => {
    expect(() => normalizeEventInput({ ...base, title: "  " })).toThrow();
  });
  it("stores all-day events as start-of-day to end-of-day", () => {
    const r = normalizeEventInput({
      title: "Tatil",
      allDay: true,
      startsAt: "2026-03-10",
      endsAt: "2026-03-11",
    });
    expect(r.startsAt.toISOString()).toBe("2026-03-09T21:00:00.000Z");
    expect(r.endsAt.toISOString()).toBe("2026-03-11T20:59:59.999Z");
  });
  it("rejects wrong shape for the mode", () => {
    expect(() =>
      normalizeEventInput({
        title: "x",
        allDay: true,
        startsAt: "2026-03-10T10:00",
        endsAt: "2026-03-10T11:00",
      }),
    ).toThrow();
  });
});

describe("calendar service", () => {
  it("creates and lists events and due todos in the month", async () => {
    const ev = await createEvent(memberA, base);
    expect(ev.createdById).toBe(memberA.userId);
    expect(ev.startsAt.toISOString()).toBe("2026-03-10T07:00:00.000Z");

    const list = await db.todoList.create({
      data: { workspaceId: ctxA.workspaceId, createdById: ctxA.userId, name: "L" },
    });
    await db.todoItem.create({
      data: {
        workspaceId: ctxA.workspaceId,
        listId: list.id,
        createdById: ctxA.userId,
        title: "Due",
        dueDate: new Date("2026-03-15T00:00:00.000Z"),
      },
    });
    const res = await listMonth(ctxA, "2026-03");
    expect(res.events.map((e) => e.id)).toContain(ev.id);
    expect(res.todos.map((t) => t.title)).toContain("Due");
    const other = await listMonth(ctxA, "2026-05");
    expect(other.events.map((e) => e.id)).not.toContain(ev.id);
  });

  it("rejects invalid month", async () => {
    await expect(listMonth(ctxA, "2026-13")).rejects.toThrow();
  });
});

describe("tenant isolation", () => {
  it("B cannot see, read, update or delete A events, and lists are separate", async () => {
    const evA = await createEvent(ctxA, { ...base, title: "A-only" });
    const evB = await createEvent(ctxB, { ...base, title: "B-only" });

    const listB = await listMonth(ctxB, "2026-03");
    expect(listB.events.map((e) => e.id)).toContain(evB.id);
    expect(listB.events.map((e) => e.id)).not.toContain(evA.id);
    const listA = await listMonth(ctxA, "2026-03");
    expect(listA.events.map((e) => e.id)).not.toContain(evB.id);

    await expect(getEvent(ctxB, evA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updateEvent(ctxB, evA.id, { ...base, title: "hacked" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(deleteEvent(ctxB, evA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const still = await db.event.findUnique({ where: { id: evA.id } });
    expect(still?.title).toBe("A-only");
  });

  it("does not leak B todos into A calendar", async () => {
    const list = await db.todoList.create({
      data: { workspaceId: ctxB.workspaceId, createdById: ctxB.userId, name: "LB" },
    });
    await db.todoItem.create({
      data: {
        workspaceId: ctxB.workspaceId,
        listId: list.id,
        createdById: ctxB.userId,
        title: "B-secret-todo",
        dueDate: new Date("2026-03-16T00:00:00.000Z"),
      },
    });
    const res = await listMonth(ctxA, "2026-03");
    expect(res.todos.map((t) => t.title)).not.toContain("B-secret-todo");
  });
});

describe("permissions", () => {
  it("member cannot edit/delete another member event; admin and author can", async () => {
    const ev = await createEvent(memberA, base);
    await expect(updateEvent(memberA2, ev.id, { ...base, title: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(deleteEvent(memberA2, ev.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await getEvent(memberA2, ev.id)).canEdit).toBe(false);

    const upd = await updateEvent(adminA, ev.id, { ...base, title: "by admin" });
    expect(upd.title).toBe("by admin");
    expect((await updateEvent(memberA, ev.id, { ...base, title: "by author" })).title).toBe(
      "by author",
    );

    await deleteEvent(adminA, ev.id);
    expect(await db.event.findUnique({ where: { id: ev.id } })).toBeNull();

    const own = await createEvent(memberA2, base);
    await deleteEvent(memberA2, own.id);
    expect(await db.event.findUnique({ where: { id: own.id } })).toBeNull();
  });
});

describe("display formatting is pinned to Europe/Istanbul (server TZ regression)", () => {
  it("formatDateTime / formatDate print Istanbul wall time in any process TZ", async () => {
    const { formatDate, formatDateTime } = await import("@/lib/format");
    const prev = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/New_York", "Asia/Tokyo"]) {
        process.env.TZ = tz;
        expect(formatDateTime(new Date("2026-11-11T11:30:00Z"))).toBe("11 Kasım 2026 14:30");
        // 22:30 UTC is already the next day in Istanbul.
        expect(formatDate(new Date("2026-11-11T22:30:00Z"))).toBe("12 Kasım 2026");
        expect(formatDate("2026-11-11T22:30:00Z", "d MMM yyyy")).toBe("12 Kas 2026");
      }
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});

describe("multi-day event labels (regression)", () => {
  it("agenda shows start on the first day, end on the last, all-day in between", async () => {
    const { agendaTimeLabel } = await import("@/lib/event-labels");
    const e = {
      allDay: false,
      startKey: "2026-11-09",
      endKey: "2026-11-11",
      startTime: "22:00",
      endTime: "10:00",
    };
    expect(agendaTimeLabel(e, "2026-11-09")).toBe("22:00 →");
    expect(agendaTimeLabel(e, "2026-11-10")).toBe("Tüm gün");
    expect(agendaTimeLabel(e, "2026-11-11")).toBe("→ 10:00");
    expect(agendaTimeLabel({ ...e, endKey: "2026-11-09", endTime: "23:00" }, "2026-11-09")).toBe("22:00 - 23:00");
  });

  it("overview names the end date of a multi-day timed event", async () => {
    const { eventWhen } = await import("@/lib/event-labels");
    const when = eventWhen({
      startsAt: new Date("2026-11-09T19:00:00Z"), // Mon 22:00 Istanbul
      endsAt: new Date("2026-11-11T07:00:00Z"), // Wed 10:00 Istanbul
      allDay: false,
    });
    expect(when).toBe("9 Kasım Pazartesi 22:00 – 11 Kasım 10:00");
    expect(
      eventWhen({ startsAt: new Date("2026-11-09T07:00:00Z"), endsAt: new Date("2026-11-09T08:00:00Z"), allDay: false }),
    ).toBe("9 Kasım Pazartesi · 10:00–11:00");
  });
});
