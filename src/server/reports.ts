import { dateOnlyToDb, dbToDateOnly, isDateOnly, todayDateOnly } from "@/lib/date-only";
import { db } from "@/lib/db";
import { addDaysToKey } from "@/lib/istanbul-time";
import type { TenantContext } from "@/lib/tenant-context";
import { listUpcomingEvents, type EventWithAccess } from "@/server/calendar";
import { ServiceError } from "@/server/errors";

/** "Raporlar": read-only, workspace-scoped aggregation. Soft-deleted rows are always excluded. */

export const REPORT_DUE_DAYS = 7;
export const REPORT_EVENT_DAYS = 14;
const MAX_TODOS = 200;

export type ReportTodo = {
  id: string;
  title: string;
  dueDate: string;
  listName: string;
  assigneeId: string | null;
  assigneeName: string | null;
};

export type OverdueGroup = { assigneeId: string | null; assigneeName: string | null; items: ReportTodo[] };
export type WorkloadRow = { userId: string; name: string; openCount: number };

export type Reports = {
  overdue: { total: number; groups: OverdueGroup[] };
  dueSoon: ReportTodo[];
  events: EventWithAccess[];
  workload: WorkloadRow[];
};

/** Group overdue items by assignee: biggest group first, unassigned last. */
export function groupOverdueByAssignee(items: ReportTodo[]): OverdueGroup[] {
  const map = new Map<string | null, OverdueGroup>();
  for (const t of items) {
    const g = map.get(t.assigneeId) ?? { assigneeId: t.assigneeId, assigneeName: t.assigneeName, items: [] };
    g.items.push(t);
    map.set(t.assigneeId, g);
  }
  return [...map.values()].sort((a, b) => {
    if ((a.assigneeId === null) !== (b.assigneeId === null)) return a.assigneeId === null ? 1 : -1;
    return b.items.length - a.items.length || (a.assigneeName ?? "").localeCompare(b.assigneeName ?? "", "tr");
  });
}

export async function getReports(ctx: TenantContext, opts: { today?: string; now?: Date } = {}): Promise<Reports> {
  const today = opts.today ?? todayDateOnly(opts.now);
  if (!isDateOnly(today)) throw new ServiceError("VALIDATION", "Geçersiz tarih.");
  const open = { workspaceId: ctx.workspaceId, status: "OPEN" as const, deletedAt: null };
  const include = { assignee: { select: { name: true } }, list: { select: { name: true } } };
  const toReport = (r: {
    id: string;
    title: string;
    dueDate: Date | null;
    assigneeId: string | null;
    assignee: { name: string | null } | null;
    list: { name: string };
  }): ReportTodo => ({
    id: r.id,
    title: r.title,
    dueDate: dbToDateOnly(r.dueDate as Date),
    listName: r.list.name,
    assigneeId: r.assigneeId,
    assigneeName: r.assignee?.name ?? null,
  });
  const overdueWhere = { ...open, dueDate: { lt: dateOnlyToDb(today) } };

  const [overdueRows, overdueTotal, dueRows, events, members, counts] = await Promise.all([
    db.todoItem.findMany({
      where: overdueWhere,
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      take: MAX_TODOS,
      include,
    }),
    db.todoItem.count({ where: overdueWhere }),
    db.todoItem.findMany({
      where: { ...open, dueDate: { gte: dateOnlyToDb(today), lte: dateOnlyToDb(addDaysToKey(today, REPORT_DUE_DAYS)) } },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      take: MAX_TODOS,
      include,
    }),
    listUpcomingEvents(ctx, { days: REPORT_EVENT_DAYS, take: 50, now: opts.now }),
    db.membership.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: { user: { select: { name: true } } },
    }),
    db.todoItem.groupBy({ by: ["assigneeId"], where: { ...open, assigneeId: { not: null } }, _count: { _all: true } }),
  ]);

  const countById = new Map(counts.map((c) => [c.assigneeId, c._count._all]));
  const workload = members
    .map((m) => ({ userId: m.userId, name: m.user.name ?? "Üye", openCount: countById.get(m.userId) ?? 0 }))
    .sort((a, b) => b.openCount - a.openCount || a.name.localeCompare(b.name, "tr"));

  return {
    overdue: { total: overdueTotal, groups: groupOverdueByAssignee(overdueRows.map(toReport)) },
    dueSoon: dueRows.map(toReport),
    events,
    workload,
  };
}
