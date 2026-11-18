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
import { canModify } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { eventActivityPath, forgetActivity, recordActivity } from "@/server/activity";
import { forbidden, notFound, parseInput, ServiceError } from "@/server/errors";
import { notifyEventCreated } from "@/server/notifications";
import { autoSubscribe } from "@/server/subscriptions";

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
  return {
    title: v.title,
    description: v.description,
    location: v.location,
    allDay: v.allDay,
    startsAt,
    endsAt,
  };
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
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        startsAt: { lte: rangeEnd },
        endsAt: { gte: rangeStart },
      },
      orderBy: [{ startsAt: "asc" }, { title: "asc" }],
    }),
    // Read-only: todo due dates are @db.Date (stored as UTC midnight).
    db.todoItem.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
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

  return {
    grid,
    events: events.map<EventWithAccess>((e) => ({ ...e, canEdit: canModify(ctx, e.createdById) })),
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
  const events = await db.event.findMany({
    where: { workspaceId: ctx.workspaceId, deletedAt: null, endsAt: { gte: now }, startsAt: { lte: until } },
    orderBy: [{ startsAt: "asc" }, { title: "asc" }],
    take,
  });
  return events.map((e) => ({ ...e, canEdit: canModify(ctx, e.createdById) }));
}

export async function getEvent(ctx: TenantContext, id: string): Promise<EventWithAccess> {
  const event = await db.event.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null } });
  if (!event) throw notFound("Etkinlik bulunamadı.");
  return { ...event, canEdit: canModify(ctx, event.createdById) };
}

export async function createEvent(ctx: TenantContext, input: unknown): Promise<Event> {
  const data = normalizeEventInput(input);
  const event = await db.event.create({
    data: { ...data, workspaceId: ctx.workspaceId, createdById: ctx.userId },
  });
  await autoSubscribe(ctx, { type: "event", id: event.id }, [ctx.userId]);
  await notifyEventCreated(ctx, event); // after the main write; never throws
  await recordActivity(ctx, {
    type: "EVENT_CREATED",
    title: event.title,
    path: eventActivityPath(event),
    subject: { type: "event", id: event.id },
  });
  return event;
}

export async function updateEvent(ctx: TenantContext, id: string, input: unknown): Promise<Event> {
  const data = normalizeEventInput(input);
  const existing = await db.event.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null } });
  if (!existing) throw notFound("Etkinlik bulunamadı.");
  if (!canModify(ctx, existing.createdById)) {
    throw forbidden("Bu etkinliği yalnızca oluşturan kişi veya yöneticiler düzenleyebilir.");
  }
  const res = await db.event.updateMany({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null }, data });
  if (res.count === 0) throw notFound("Etkinlik bulunamadı.");
  const event = await db.event.findFirstOrThrow({ where: { id, workspaceId: ctx.workspaceId } });
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
  const existing = await db.event.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null } });
  if (!existing) throw notFound("Etkinlik bulunamadı.");
  if (!canModify(ctx, existing.createdById)) {
    throw forbidden("Bu etkinliği yalnızca oluşturan kişi veya yöneticiler silebilir.");
  }
  await db.$transaction(async (tx) => {
    await forgetActivity(ctx, [{ type: "event", id: existing.id }], tx);
    await tx.event.updateMany({
      where: { id: existing.id, workspaceId: ctx.workspaceId, deletedAt: null },
      data: { deletedAt: new Date(), deletedById: ctx.userId, updatedAt: existing.updatedAt },
    });
  });
}
