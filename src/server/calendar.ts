import type { Event, TodoItem } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  addDaysToKey,
  buildMonthGrid,
  isMonthParam,
  istanbulDayEnd,
  istanbulDayKey,
  istanbulDayStart,
  parseIstanbulLocal,
} from "@/lib/istanbul-time";
import { expandOccurrences, RECURRENCES, type Occurrence } from "@/lib/recurrence";
import { canModify, clientVisibleWhere } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { eventActivityPath, forgetActivity, recordActivity, syncActivityInternal } from "@/server/activity";
import { resolveInternal, resolveInternalUpdate } from "@/server/client-visibility";
import { forbidden, notFound, parseInput, ServiceError } from "@/server/errors";
import { notifyEventCreated, notifyEventInvited } from "@/server/notifications";
import { remindAtField, reminderColumns } from "@/server/reminders";
import { assertAssignableProject, projectIdField } from "@/server/projects";
import { autoSubscribe } from "@/server/subscriptions";
import { deleteReactionsFor } from "@/server/reactions";

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} en fazla ${max} karakter olabilir.`)
    .optional()
    .transform((v) => (v ? v : null));

const eventInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Başlık gerekli.")
    .max(200, "Başlık en fazla 200 karakter olabilir."),
  description: optionalText(5000, "Açıklama"),
  location: optionalText(200, "Konum"),
  allDay: z.boolean().default(false),
  /** Istanbul wall time: "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:mm". */
  startsAt: z.string().trim().min(1, "Başlangıç gerekli."),
  endsAt: z.string().trim().min(1, "Bitiş gerekli."),
  /** Omitted = leave unchanged on update / NONE on create. */
  recurrence: z.enum(RECURRENCES, { error: "Geçersiz tekrar türü." }).optional(),
  /** "YYYY-MM-DD" (Istanbul); empty = open-ended. Ignored when recurrence is NONE. */
  recurrenceUntil: z.string().trim().optional(),
  /** Member ids to invite. Omitted = leave the invitee list unchanged on update. */
  inviteeIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  /** Optional project, honoured on create only; empty / omitted = "Genel". */
  projectId: projectIdField,
  /** "Yalnızca ekip": hidden from guests (ignored when a guest writes). Omitted = unchanged on update. */
  internal: z.boolean().optional(),
  /** Reminder: Istanbul "YYYY-MM-DDTHH:mm"; empty clears it, omitted = unchanged on update. */
  remindAt: remindAtField,
});

export type EventInput = z.input<typeof eventInputSchema>;

/** Validate input and convert Istanbul wall time to UTC instants. */
export function normalizeEventInput(input: unknown) {
  const v = parseInput(eventInputSchema, input);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const withTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  const shape = v.allDay ? dateOnly : withTime;
  const fieldErrors: Record<string, string[]> = {};
  const startOk = shape.test(v.startsAt) ? parseIstanbulLocal(v.startsAt) : null;
  const endOk = shape.test(v.endsAt) ? parseIstanbulLocal(v.endsAt) : null;
  if (!startOk) fieldErrors.startsAt = ["Geçerli bir başlangıç girin."];
  if (!endOk) fieldErrors.endsAt = ["Geçerli bir bitiş girin."];
  if (Object.keys(fieldErrors).length) {
    throw new ServiceError("VALIDATION", "Tarih bilgileri geçersiz.", fieldErrors);
  }
  let startsAt = startOk as Date;
  let endsAt = endOk as Date;
  if (v.allDay) {
    // Store start-of-day .. end-of-day (Istanbul).
    startsAt = istanbulDayStart(v.startsAt);
    endsAt = istanbulDayEnd(v.endsAt);
  }
  if (endsAt.getTime() < startsAt.getTime()) {
    throw new ServiceError("VALIDATION", "Bitiş, başlangıçtan önce olamaz.", {
      endsAt: ["Bitiş, başlangıçtan önce olamaz."],
    });
  }
  let recurrenceUntil: Date | null | undefined;
  if (v.recurrence === "NONE") recurrenceUntil = null;
  else if (v.recurrence !== undefined) {
    if (v.recurrenceUntil) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.recurrenceUntil) || !parseIstanbulLocal(v.recurrenceUntil)) {
        throw new ServiceError("VALIDATION", "Tekrar bitiş tarihi geçersiz.", {
          recurrenceUntil: ["Geçerli bir tarih girin."],
        });
      }
      recurrenceUntil = istanbulDayEnd(v.recurrenceUntil);
      if (recurrenceUntil.getTime() < startsAt.getTime()) {
        throw new ServiceError("VALIDATION", "Tekrar bitişi, başlangıçtan önce olamaz.", {
          recurrenceUntil: ["Tekrar bitişi, başlangıçtan önce olamaz."],
        });
      }
    } else {
      recurrenceUntil = null;
    }
  }
  return {
    title: v.title,
    description: v.description,
    location: v.location,
    allDay: v.allDay,
    startsAt,
    endsAt,
    recurrence: v.recurrence,
    recurrenceUntil,
    inviteeIds: v.inviteeIds,
    projectId: v.projectId,
    internal: v.internal,
    remindAt: v.remindAt,
  };
}

/** The columns persisted on Event (normalizeEventInput minus the invitee list). */
function eventColumns(data: ReturnType<typeof normalizeEventInput>) {
  const { inviteeIds: _inviteeIds, projectId: _projectId, internal: _internal, remindAt, ...columns } = data;
  void _inviteeIds;
  void _projectId;
  void _internal;
  return { ...columns, ...(remindAt !== undefined ? { remindAt } : {}) };
}

/** One calendar occurrence of an event (a non-recurring event has exactly one, index 0). */
export type EventOccurrence = Occurrence & { event: EventWithAccess };

/** Where clause: events whose span (or any recurrence) can overlap [from, to]. */
function overlapWhere(from: Date, to: Date) {
  return {
    OR: [
      { recurrence: "NONE", startsAt: { lte: to }, endsAt: { gte: from } },
      {
        recurrence: { not: "NONE" },
        startsAt: { lte: to },
        OR: [{ recurrenceUntil: null }, { recurrenceUntil: { gte: from } }],
      },
    ],
  };
}

/** Keep only invitees that are workspace members (de-duplicated). */
async function validInvitees(ctx: TenantContext, ids: string[]): Promise<string[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  const rows = await db.membership.findMany({
    where: { workspaceId: ctx.workspaceId, userId: { in: wanted } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Make the invitee list equal `ids`; returns the user ids that were newly added. */
async function syncInvitees(ctx: TenantContext, eventId: string, ids: string[]): Promise<string[]> {
  const wanted = await validInvitees(ctx, ids);
  const existing = await db.eventInvitee.findMany({
    where: { eventId, workspaceId: ctx.workspaceId },
    select: { userId: true },
  });
  const have = new Set(existing.map((r) => r.userId));
  const added = wanted.filter((id) => !have.has(id));
  const removed = [...have].filter((id) => !wanted.includes(id));
  if (removed.length) {
    await db.eventInvitee.deleteMany({ where: { eventId, workspaceId: ctx.workspaceId, userId: { in: removed } } });
  }
  if (added.length) {
    await db.eventInvitee.createMany({
      data: added.map((userId) => ({ workspaceId: ctx.workspaceId, eventId, userId })),
      skipDuplicates: true,
    });
  }
  return added;
}

/** User ids invited to the event (workspace-scoped). */
export async function listEventInviteeIds(ctx: TenantContext, eventId: string): Promise<string[]> {
  const rows = await db.eventInvitee.findMany({
    where: { eventId, workspaceId: ctx.workspaceId },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Invitee ids for many events at once (for the month view). */
export async function listInviteeIdsByEvent(ctx: TenantContext, eventIds: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (eventIds.length === 0) return out;
  const rows = await db.eventInvitee.findMany({
    where: { workspaceId: ctx.workspaceId, eventId: { in: eventIds } },
    orderBy: { createdAt: "asc" },
    select: { eventId: true, userId: true },
  });
  for (const r of rows) (out[r.eventId] ??= []).push(r.userId);
  return out;
}

export type EventWithAccess = Event & { canEdit: boolean };

export type TodoMarker = Pick<TodoItem, "id" | "title" | "status" | "dueDate">;

/** Due-date markers loaded for one month grid (earliest first). */
export const CALENDAR_TODOS_MAX = 500;

/** Events overlapping the month's visible grid, plus todos due in it (read-only, at most CALENDAR_TODOS_MAX). */
export async function listMonth(ctx: TenantContext, month: string) {
  if (!isMonthParam(month)) throw new ServiceError("VALIDATION", "Geçersiz ay.");
  const grid = buildMonthGrid(month);
  const rangeStart = istanbulDayStart(grid.firstKey);
  const rangeEnd = istanbulDayEnd(grid.lastKey);

  const [events, todos] = await Promise.all([
    db.event.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx), ...overlapWhere(rangeStart, rangeEnd) },
      orderBy: [{ startsAt: "asc" }, { title: "asc" }],
    }),
    // Read-only: todo due dates are @db.Date (stored as UTC midnight).
    db.todoItem.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        list: { deletedAt: null, ...clientVisibleWhere(ctx) },
        dueDate: {
          gte: new Date(`${grid.firstKey}T00:00:00.000Z`),
          lte: new Date(`${grid.lastKey}T00:00:00.000Z`),
        },
      },
      select: { id: true, title: true, status: true, dueDate: true },
      orderBy: [{ dueDate: "asc" }, { position: "asc" }, { id: "asc" }],
      // Markers only: a month with thousands of due to-dos stays bounded.
      take: CALENDAR_TODOS_MAX,
    }),
  ]);

  const withAccess = events.map<EventWithAccess>((e) => ({ ...e, canEdit: canModify(ctx, e.createdById) }));
  // Recurring events are expanded into the occurrences that fall in the grid; an
  // event with none in range (e.g. UNTIL passed) is dropped from `events`.
  const occurrences: EventOccurrence[] = [];
  for (const e of withAccess) {
    for (const o of expandOccurrences(e, rangeStart, rangeEnd)) occurrences.push({ ...o, event: e });
  }
  occurrences.sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.event.title.localeCompare(b.event.title),
  );
  const present = new Set(occurrences.map((o) => o.event.id));

  return {
    grid,
    events: withAccess.filter((e) => present.has(e.id)),
    occurrences,
    todos: todos as TodoMarker[],
  };
}

/**
 * Events still running or starting between now and the end of the Istanbul day
 * `days` days from today (so "next 14 days" includes today). Ascending by start.
 */
export async function listUpcomingEvents(
  ctx: TenantContext,
  opts: { days?: number; take?: number; now?: Date } = {},
): Promise<EventWithAccess[]> {
  const days = Math.min(Math.max(opts.days ?? 14, 1), 90);
  const take = Math.min(Math.max(opts.take ?? 6, 1), 50);
  const now = opts.now ?? new Date();
  const until = istanbulDayEnd(addDaysToKey(istanbulDayKey(now), days));
  const base = { workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) };
  const [plain, recurring] = await Promise.all([
    db.event.findMany({
      where: { ...base, recurrence: "NONE", endsAt: { gte: now }, startsAt: { lte: until } },
      orderBy: [{ startsAt: "asc" }, { title: "asc" }],
      take,
    }),
    db.event.findMany({
      where: { ...base, ...overlapWhere(now, until), recurrence: { not: "NONE" } },
      take: 200,
    }),
  ]);
  // A recurring event shows once, as its next occurrence in the window.
  const upcoming = [
    ...plain,
    ...recurring.flatMap((e) => {
      const next = expandOccurrences(e, now, until)[0];
      return next ? [{ ...e, startsAt: next.startsAt, endsAt: next.endsAt }] : [];
    }),
  ];
  upcoming.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.title.localeCompare(b.title));
  return upcoming.slice(0, take).map((e) => ({ ...e, canEdit: canModify(ctx, e.createdById) }));
}

export async function getEvent(ctx: TenantContext, id: string): Promise<EventWithAccess> {
  const event = await db.event.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
  });
  if (!event) throw notFound("Etkinlik bulunamadı.");
  return { ...event, canEdit: canModify(ctx, event.createdById) };
}

export async function createEvent(ctx: TenantContext, input: unknown): Promise<Event> {
  const parsed = normalizeEventInput(input);
  const projectId = await assertAssignableProject(ctx, parsed.projectId);
  const event = await db.event.create({
    data: {
      ...eventColumns(parsed),
      projectId,
      internal: resolveInternal(ctx, parsed.internal),
      workspaceId: ctx.workspaceId,
      createdById: ctx.userId,
    },
  });
  await autoSubscribe(ctx, { type: "event", id: event.id }, [ctx.userId]);
  const invited = parsed.inviteeIds ? await syncInvitees(ctx, event.id, parsed.inviteeIds) : [];
  // Invitees get the (more specific) invite notification instead of the generic one.
  await notifyEventCreated(ctx, event, invited); // after the main write; never throws
  if (invited.length) await notifyEventInvited(ctx, event, invited);
  await recordActivity(ctx, {
    type: "EVENT_CREATED",
    title: event.title,
    path: eventActivityPath(event),
    subject: { type: "event", id: event.id },
  });
  return event;
}

export async function updateEvent(ctx: TenantContext, id: string, input: unknown): Promise<Event> {
  const parsed = normalizeEventInput(input);
  const data = eventColumns(parsed);
  const existing = await db.event.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
  });
  if (!existing) throw notFound("Etkinlik bulunamadı.");
  if (!canModify(ctx, existing.createdById)) {
    throw forbidden("Bu etkinliği yalnızca oluşturan kişi veya yöneticiler düzenleyebilir.");
  }
  const internal = resolveInternalUpdate(ctx, parsed.internal);
  const res = await db.event.updateMany({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
    data: { ...data, ...reminderColumns(parsed.remindAt, existing.remindAt), ...(internal !== undefined ? { internal } : {}) },
  });
  if (res.count === 0) throw notFound("Etkinlik bulunamadı.");
  if (internal !== undefined && internal !== existing.internal) await syncActivityInternal(ctx, { type: "event", id });
  const event = await db.event.findFirstOrThrow({ where: { id, workspaceId: ctx.workspaceId } });
  if (parsed.inviteeIds) {
    const added = await syncInvitees(ctx, event.id, parsed.inviteeIds);
    if (added.length) await notifyEventInvited(ctx, event, added);
  }
  await recordActivity(ctx, {
    type: "EVENT_UPDATED",
    title: event.title,
    path: eventActivityPath(event),
    subject: { type: "event", id: event.id },
  });
  return event;
}

/** Moves the event to the trash (soft delete). */
export async function deleteEvent(ctx: TenantContext, id: string): Promise<void> {
  const existing = await db.event.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
  });
  if (!existing) throw notFound("Etkinlik bulunamadı.");
  if (!canModify(ctx, existing.createdById)) {
    throw forbidden("Bu etkinliği yalnızca oluşturan kişi veya yöneticiler silebilir.");
  }
  await db.$transaction(async (tx) => {
    await forgetActivity(ctx, [{ type: "event", id: existing.id }], tx);
    await deleteReactionsFor(tx, ctx.workspaceId, "event", [existing.id]);
    await tx.event.updateMany({
      where: { id: existing.id, workspaceId: ctx.workspaceId, deletedAt: null },
      data: { deletedAt: new Date(), deletedById: ctx.userId, updatedAt: existing.updatedAt },
    });
  });
}

/** Max events written to the iCal feed. */
export const ICAL_FEED_MAX = 2000;

/** All non-deleted events of the workspace (recurring ones once, with their RRULE data) for the iCal feed. */
export async function listEventsForFeed(ctx: TenantContext) {
  return db.event.findMany({
    where: { workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: ICAL_FEED_MAX,
  });
}
