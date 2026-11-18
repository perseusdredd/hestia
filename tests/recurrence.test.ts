import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { buildIcs, icalEscape, icalFold } from "@/lib/ical";
import { parseIstanbulLocal } from "@/lib/istanbul-time";
import { expandOccurrences } from "@/lib/recurrence";
import type { TenantContext } from "@/lib/tenant-context";
import {
  createEvent,
  listEventInviteeIds,
  listEventsForFeed,
  listMonth,
  listUpcomingEvents,
  updateEvent,
} from "@/server/calendar";

import { cleanup, createMember, createTestUser, createTestWorkspace, disconnect } from "./helpers";

const at = (v: string) => parseIstanbulLocal(v)!;

describe("expandOccurrences", () => {
  const weekly = {
    startsAt: at("2026-03-02T10:00"),
    endsAt: at("2026-03-02T11:00"),
    recurrence: "WEEKLY",
    recurrenceUntil: null as Date | null,
  };

  it("counts weekly occurrences in a window", () => {
    const occ = expandOccurrences(weekly, at("2026-03-01T00:00"), at("2026-03-31T23:59"));
    expect(occ.map((o) => o.startsAt.toISOString())).toEqual([
      "2026-03-02T07:00:00.000Z",
      "2026-03-09T07:00:00.000Z",
      "2026-03-16T07:00:00.000Z",
      "2026-03-23T07:00:00.000Z",
      "2026-03-30T07:00:00.000Z",
    ]);
    expect(occ[1].endsAt.getTime() - occ[1].startsAt.getTime()).toBe(3600_000);
  });

  it("expands daily and monthly (clamping the 31st)", () => {
    const daily = { ...weekly, recurrence: "DAILY" };
    expect(expandOccurrences(daily, at("2026-03-05T00:00"), at("2026-03-09T23:59"))).toHaveLength(5);
    const monthly = {
      ...weekly,
      startsAt: at("2026-01-31T09:00"),
      endsAt: at("2026-01-31T10:00"),
      recurrence: "MONTHLY",
    };
    const occ = expandOccurrences(monthly, at("2026-01-01T00:00"), at("2026-04-30T23:59"));
    expect(occ.map((o) => o.startsAt.toISOString().slice(0, 10))).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("stops at recurrenceUntil (inclusive)", () => {
    const capped = { ...weekly, recurrenceUntil: at("2026-03-16T23:59") };
    const occ = expandOccurrences(capped, at("2026-03-01T00:00"), at("2026-12-31T23:59"));
    expect(occ).toHaveLength(3);
  });

  it("applies a sane cap to open-ended series", () => {
    const occ = expandOccurrences({ ...weekly, recurrence: "DAILY" }, at("2026-03-01T00:00"), at("2090-01-01T00:00"));
    expect(occ.length).toBeLessThanOrEqual(1500);
    expect(occ.length).toBeGreaterThan(1000);
  });

  it("leaves NONE exactly as a single span", () => {
    const one = { ...weekly, recurrence: "NONE" };
    expect(expandOccurrences(one, at("2026-03-01T00:00"), at("2026-03-31T23:59"))).toHaveLength(1);
    expect(expandOccurrences(one, at("2026-04-01T00:00"), at("2026-04-30T23:59"))).toHaveLength(0);
  });
});

describe("iCal output", () => {
  it("escapes and folds", () => {
    expect(icalEscape("a,b;c\nd\\e")).toBe("a\\,b\\;c\\nd\\\\e");
    const lines = icalFold("X:" + "ç".repeat(100));
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
  });

  it("writes VEVENTs with RRULE", () => {
    const ics = buildIcs(
      [
        {
          id: "e1",
          title: "Haftalik",
          description: null,
          location: "Ofis",
          allDay: false,
          startsAt: at("2026-03-02T10:00"),
          endsAt: at("2026-03-02T11:00"),
          recurrence: "WEEKLY",
          recurrenceUntil: at("2026-04-01T23:59"),
          updatedAt: new Date("2026-03-01T00:00:00Z"),
        },
        {
          id: "e2",
          title: "Tatil",
          description: "x",
          location: null,
          allDay: true,
          startsAt: at("2026-03-10"),
          endsAt: new Date(at("2026-03-12").getTime() + 86400_000 - 1),
          recurrence: "NONE",
          recurrenceUntil: null,
          updatedAt: new Date("2026-03-01T00:00:00Z"),
        },
      ],
      { name: "Ev", now: new Date("2026-03-01T00:00:00Z") },
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20260302T070000Z");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;UNTIL=20260401T205900Z");
    expect(ics).toContain("SUMMARY:Haftalik");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260310");
    expect(ics).toContain("DTEND;VALUE=DATE:20260313");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics.match(/RRULE/g)).toHaveLength(1);
  });
});

let ctxA: TenantContext;
let member1: TenantContext;
let member2: TenantContext;

beforeAll(async () => {
  const a = await createTestWorkspace((await createTestUser()).id);
  ctxA = a.ctx;
  member1 = (await createMember(a.workspace.id, "MEMBER")).ctx;
  member2 = (await createMember(a.workspace.id, "MEMBER")).ctx;
});

afterAll(async () => {
  await cleanup();
  await disconnect();
});

describe("recurring events in the calendar service", () => {
  it("expands a recurring event in the month view and honours recurrenceUntil", async () => {
    const ev = await createEvent(ctxA, {
      title: "Standup",
      startsAt: "2026-03-02T09:00",
      endsAt: "2026-03-02T09:15",
      recurrence: "WEEKLY",
      recurrenceUntil: "2026-03-16",
    });
    expect(ev.recurrence).toBe("WEEKLY");
    const march = await listMonth(ctxA, "2026-03");
    expect(march.occurrences.filter((o) => o.event.id === ev.id)).toHaveLength(3);
    expect(march.events.filter((e) => e.id === ev.id)).toHaveLength(1);
    // The April grid starts Mar 30; the series ended Mar 16, so nothing shows.
    const april = await listMonth(ctxA, "2026-04");
    expect(april.occurrences.some((o) => o.event.id === ev.id)).toBe(false);
    expect(april.events.some((e) => e.id === ev.id)).toBe(false);
    // An open-ended series that began months earlier still reaches the window.
    const open = await createEvent(ctxA, {
      title: "Gunluk",
      startsAt: "2026-01-05T08:00",
      endsAt: "2026-01-05T08:30",
      recurrence: "DAILY",
    });
    const may = await listMonth(ctxA, "2026-05");
    expect(may.occurrences.filter((o) => o.event.id === open.id).length).toBe(may.grid.days.length);
  });

  it("keeps non-recurring events unchanged (one occurrence, NONE)", async () => {
    const ev = await createEvent(ctxA, { title: "Tek", startsAt: "2026-06-10T10:00", endsAt: "2026-06-10T11:00" });
    expect(ev.recurrence).toBe("NONE");
    expect(ev.recurrenceUntil).toBeNull();
    const june = await listMonth(ctxA, "2026-06");
    expect(june.occurrences.filter((o) => o.event.id === ev.id)).toHaveLength(1);
  });

  it("lists a recurring event once, as its next occurrence, in upcoming events", async () => {
    const ev = await createEvent(ctxA, {
      title: "Haftalik toplanti",
      startsAt: "2026-07-01T10:00",
      endsAt: "2026-07-01T11:00",
      recurrence: "WEEKLY",
    });
    const list = await listUpcomingEvents(ctxA, { days: 14, take: 50, now: at("2026-07-10T00:00") });
    const hits = list.filter((e) => e.id === ev.id);
    expect(hits).toHaveLength(1);
    expect(hits[0].startsAt.toISOString()).toBe(at("2026-07-15T10:00").toISOString());
  });

  it("rejects a recurrenceUntil before the start", async () => {
    await expect(
      createEvent(ctxA, {
        title: "x",
        startsAt: "2026-03-10T10:00",
        endsAt: "2026-03-10T11:00",
        recurrence: "DAILY",
        recurrenceUntil: "2026-03-01",
      }),
    ).rejects.toThrow();
  });

  it("keeps recurrence on update when not supplied, and clears it with NONE", async () => {
    const ev = await createEvent(ctxA, {
      title: "R",
      startsAt: "2026-03-10T10:00",
      endsAt: "2026-03-10T11:00",
      recurrence: "DAILY",
    });
    const same = await updateEvent(ctxA, ev.id, {
      title: "R2",
      startsAt: "2026-03-10T10:00",
      endsAt: "2026-03-10T11:00",
    });
    expect(same.recurrence).toBe("DAILY");
    const none = await updateEvent(ctxA, ev.id, {
      title: "R2",
      startsAt: "2026-03-10T10:00",
      endsAt: "2026-03-10T11:00",
      recurrence: "NONE",
    });
    expect(none.recurrence).toBe("NONE");
  });
});

describe("event invitees", () => {
  it("adds invitees, notifies only them, and diffs on update", async () => {
    const outsider = await createTestUser();
    const ev = await createEvent(ctxA, {
      title: "Davet",
      startsAt: "2026-08-10T10:00",
      endsAt: "2026-08-10T11:00",
      inviteeIds: [member1.userId, member1.userId, outsider.id, ctxA.userId],
    });
    // De-duplicated; non-members dropped.
    expect((await listEventInviteeIds(ctxA, ev.id)).sort()).toEqual([member1.userId, ctxA.userId].sort());

    const invites = await db.notification.findMany({ where: { type: "EVENT_INVITE", workspaceId: ctxA.workspaceId } });
    expect(invites.map((n) => n.userId)).toEqual([member1.userId]);
    expect(invites[0].path).toBe(`calendar/${ev.id}`);
    // The invitee skips the generic "new event" notification; other members still get it.
    const created = await db.notification.findMany({
      where: { type: "EVENT_CREATED", workspaceId: ctxA.workspaceId, body: "Davet" },
    });
    expect(created.map((n) => n.userId)).toEqual([member2.userId]);

    await updateEvent(ctxA, ev.id, {
      title: "Davet",
      startsAt: "2026-08-10T10:00",
      endsAt: "2026-08-10T11:00",
      inviteeIds: [member1.userId, member2.userId],
    });
    expect((await listEventInviteeIds(ctxA, ev.id)).sort()).toEqual([member1.userId, member2.userId].sort());
    const after = await db.notification.findMany({ where: { type: "EVENT_INVITE", workspaceId: ctxA.workspaceId } });
    expect(after.map((n) => n.userId).sort()).toEqual([member1.userId, member2.userId].sort());

    // Omitting inviteeIds leaves the list alone.
    await updateEvent(ctxA, ev.id, { title: "Davet 2", startsAt: "2026-08-10T10:00", endsAt: "2026-08-10T11:00" });
    expect(await listEventInviteeIds(ctxA, ev.id)).toHaveLength(2);
  });

  it("feed lists the workspace events", async () => {
    const feed = await listEventsForFeed(ctxA);
    const ics = buildIcs(feed, { name: "T" });
    expect(ics).toContain("SUMMARY:Standup");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;UNTIL=");
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(feed.length);
  });
});
