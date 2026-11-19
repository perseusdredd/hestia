import { z } from "zod";

import { db } from "@/lib/db";
import { parseIstanbulLocal } from "@/lib/istanbul-time";
import { notify } from "@/server/notifications";

/**
 * Reminders ("Hatırlatma") on to-dos and events.
 *
 * remindAt (UTC instant) is entered as Istanbul wall time "YYYY-MM-DDTHH:mm".
 * null = no reminder. The cron (runDueReminders) fires each reminder once and
 * stamps reminderSentAt; clearing or moving remindAt re-arms it.
 */

const WALL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Input field: undefined = leave unchanged, ""/null = clear, otherwise an
 * Istanbul "YYYY-MM-DDTHH:mm". Output: undefined | null | Date.
 */
export const remindAtField = z
  .preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
    z
      .string({ error: "Geçerli bir hatırlatma zamanı girin." })
      .nullable()
      .refine((v) => v === null || (WALL_TIME.test(v) && parseIstanbulLocal(v) !== null), {
        message: "Geçerli bir hatırlatma zamanı girin.",
      }),
  )
  .transform((v) => (v === null ? null : parseIstanbulLocal(v) as Date))
  .optional();

/**
 * Columns to write for a new remindAt value. Changing or clearing the time
 * re-arms the reminder (reminderSentAt back to null); an unchanged time keeps it.
 */
export function reminderColumns(next: Date | null | undefined, current: Date | null) {
  if (next === undefined) return {};
  if (next !== null && current !== null && next.getTime() === current.getTime()) return {};
  return { remindAt: next, reminderSentAt: null };
}

const SYSTEM_ROLE = "MEMBER" as const;

/**
 * Fires every due reminder (remindAt <= now, not yet sent, not deleted) and
 * returns how many fired. Each item is claimed with a conditional update before
 * notifying, so a concurrent or repeated run sends nothing twice.
 * Completed to-dos are stamped as sent without notifying (nothing to remind).
 */
export async function runDueReminders(now: Date): Promise<number> {
  let fired = 0;
  const due = { remindAt: { lte: now }, reminderSentAt: null, deletedAt: null } as const;

  const todos = await db.todoItem.findMany({
    where: { ...due, list: { deletedAt: null } },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      status: true,
      assigneeId: true,
      createdById: true,
      remindAt: true,
      extraAssignees: { select: { userId: true } },
      list: { select: { internal: true } },
    },
    orderBy: [{ remindAt: "asc" }, { id: "asc" }],
    take: 1000,
  });
  for (const t of todos) {
    const claim = await db.todoItem.updateMany({
      where: { ...due, id: t.id, workspaceId: t.workspaceId, remindAt: t.remindAt },
      data: { reminderSentAt: now },
    });
    if (claim.count === 0) continue;
    if (t.status === "DONE") continue;
    const recipientIds = [
      ...new Set([...(t.assigneeId ? [t.assigneeId] : []), ...t.extraAssignees.map((e) => e.userId), t.createdById]),
    ];
    await notify(
      { userId: t.createdById, workspaceId: t.workspaceId, role: SYSTEM_ROLE },
      {
        recipientIds,
        type: "REMINDER",
        title: "Görev hatırlatması",
        body: t.title,
        path: `todos/${t.id}`,
        internal: t.list.internal,
        system: true,
      },
    );
    fired++;
  }

  const events = await db.event.findMany({
    where: due,
    select: {
      id: true,
      workspaceId: true,
      title: true,
      createdById: true,
      internal: true,
      remindAt: true,
      invitees: { select: { userId: true } },
    },
    orderBy: [{ remindAt: "asc" }, { id: "asc" }],
    take: 1000,
  });
  for (const e of events) {
    const claim = await db.event.updateMany({
      where: { ...due, id: e.id, workspaceId: e.workspaceId, remindAt: e.remindAt },
      data: { reminderSentAt: now },
    });
    if (claim.count === 0) continue;
    const recipientIds = [...new Set([e.createdById, ...e.invitees.map((i) => i.userId)])];
    await notify(
      { userId: e.createdById, workspaceId: e.workspaceId, role: SYSTEM_ROLE },
      {
        recipientIds,
        type: "REMINDER",
        title: "Etkinlik hatırlatması",
        body: e.title,
        path: `calendar/${e.id}`,
        internal: e.internal,
        system: true,
      },
    );
    fired++;
  }
  return fired;
}
