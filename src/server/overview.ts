import { z } from "zod";

import { dateOnlyToDb, isDateOnly, todayDateOnly } from "@/lib/date-only";
import { db } from "@/lib/db";
import { addDaysToKey, istanbulDayEnd, istanbulDayStart } from "@/lib/istanbul-time";
import { expandOccurrences } from "@/lib/recurrence";
import { clientVisibleWhere } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { todoItemClientWhere } from "@/server/client-visibility";
import { parseInput } from "@/server/errors";

/**
 * The overview page's row of numbers. Four COUNT queries run in parallel, each
 * scoped by ctx.workspaceId (the unread count also by ctx.userId); no rows are
 * loaded.
 */

export type OverviewCounts = {
  /** Open to-dos in the whole workspace. */
  openTodos: number;
  /** Open to-dos whose due date is before today (Istanbul). */
  overdueTodos: number;
  /** Events overlapping the current Istanbul week (Monday to Sunday). */
  eventsThisWeek: number;
  /** The caller's unread notifications in this workspace. */
  unreadNotifications: number;
};

const optsSchema = z.object({
  today: z.string().refine(isDateOnly, "Geçersiz tarih.").optional(),
});

/** Monday..Sunday (as day keys) of the week that contains `dayKey`. */
export function istanbulWeek(dayKey: string): { first: string; last: string } {
  // A day key is a calendar date; its weekday does not depend on a time zone.
  const weekday = new Date(`${dayKey}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
  const first = addDaysToKey(dayKey, -((weekday + 6) % 7));
  return { first, last: addDaysToKey(first, 6) };
}

export async function getOverviewCounts(
  ctx: TenantContext,
  input: { today?: string } = {},
): Promise<OverviewCounts> {
  const opts = parseInput(optsSchema, input);
  const today = opts.today ?? todayDateOnly();
  const week = istanbulWeek(today);
  const open = {
    workspaceId: ctx.workspaceId,
    status: "OPEN" as const,
    deletedAt: null,
    ...todoItemClientWhere(ctx),
  };
  const visibleEvents = { workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) };

  const weekStart = istanbulDayStart(week.first);
  const weekEnd = istanbulDayEnd(week.last);

  const [openTodos, overdueTodos, plainEvents, recurringEvents, unreadNotifications] = await Promise.all([
    db.todoItem.count({ where: open }),
    db.todoItem.count({ where: { ...open, dueDate: { lt: dateOnlyToDb(today) } } }),
    db.event.count({
      where: {
        ...visibleEvents,
        recurrence: "NONE",
        startsAt: { lte: weekEnd },
        endsAt: { gte: weekStart },
      },
    }),
    // Recurring events count when any occurrence falls in the week (same rule as the calendar).
    db.event.findMany({
      where: {
        ...visibleEvents,
        recurrence: { not: "NONE" },
        startsAt: { lte: weekEnd },
        OR: [{ recurrenceUntil: null }, { recurrenceUntil: { gte: weekStart } }],
      },
      select: { startsAt: true, endsAt: true, recurrence: true, recurrenceUntil: true },
    }),
    db.notification.count({ where: { workspaceId: ctx.workspaceId, userId: ctx.userId, readAt: null } }),
  ]);
  const eventsThisWeek =
    plainEvents + recurringEvents.filter((e) => expandOccurrences(e, weekStart, weekEnd).length > 0).length;
  return { openTodos, overdueTodos, eventsThisWeek, unreadNotifications };
}
