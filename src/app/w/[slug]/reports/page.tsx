import Link from "next/link";
import { AlertTriangle, BarChart3, CalendarDays, CheckSquare, Users, type LucideIcon } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { workspaceHref } from "@/components/shell/nav-items";
import { Badge } from "@/components/ui/badge";
import { formatDueDate, todayDateOnly } from "@/lib/date-only";
import { eventWhen } from "@/lib/event-labels";
import { istanbulDayKey } from "@/lib/istanbul-time";
import { requireWorkspace } from "@/lib/tenant";
import { getReports, REPORT_DUE_DAYS, REPORT_EVENT_DAYS, type ReportTodo } from "@/server/reports";

export const metadata = { title: "Raporlar" };

const rowClass =
  "flex min-w-0 items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

function Section({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-xl border bg-card shadow-xs" aria-label={title}>
      <h2 className="flex items-center gap-2 px-4 pt-3.5 pb-1.5 text-section-title">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        {title}
      </h2>
      <div className="flex-1 px-2 pt-1 pb-2">{children}</div>
    </section>
  );
}

function TodoRow({ t, href, showAssignee }: { t: ReportTodo; href: string; showAssignee?: boolean }) {
  return (
    <li>
      <Link href={href} className={rowClass}>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{t.title}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            <span className="truncate">{t.listName}</span>
            <span className="tabular">· {formatDueDate(t.dueDate, "d MMMM")}</span>
            {showAssignee ? <span className="truncate">· {t.assigneeName ?? "Atanmamış"}</span> : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

export default async function ReportsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const r = await getReports(ctx, { today: todayDateOnly() });
  const href = (segment: string) => workspaceHref(slug, segment);

  return (
    <div className="space-y-6 sm:space-y-8">
      <PageHeader title="Raporlar" description="Çalışma alanındaki gecikmiş işler, yaklaşan teslimler ve iş yükü." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={`Geciken görevler (${r.overdue.total})`} icon={AlertTriangle}>
          {r.overdue.groups.length === 0 ? (
            <EmptyState compact icon={CheckSquare} title="Geciken görev yok" />
          ) : (
            <div className="space-y-3">
              {r.overdue.groups.map((g) => (
                <div key={g.assigneeId ?? "none"}>
                  <h3 className="flex items-center gap-1.5 px-2 pb-1 text-xs font-medium text-destructive">
                    {g.assigneeName ?? "Atanmamış"} ({g.items.length})
                  </h3>
                  <ul>
                    {g.items.map((t) => (
                      <TodoRow key={t.id} t={t} href={href(`todos/${t.id}`)} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title={`Bu hafta biten görevler (${REPORT_DUE_DAYS} gün)`} icon={CheckSquare}>
          {r.dueSoon.length === 0 ? (
            <EmptyState compact icon={CheckSquare} title="Önümüzdeki günlerde teslim yok" />
          ) : (
            <ul>
              {r.dueSoon.map((t) => (
                <TodoRow key={t.id} t={t} href={href(`todos/${t.id}`)} showAssignee />
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Yaklaşan etkinlikler (${REPORT_EVENT_DAYS} gün)`} icon={CalendarDays}>
          {r.events.length === 0 ? (
            <EmptyState compact icon={CalendarDays} title="Yaklaşan etkinlik yok" />
          ) : (
            <ul>
              {r.events.map((e) => (
                <li key={e.id}>
                  <Link href={href(`calendar/${e.id}`)} className={rowClass}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{e.title}</span>
                      <span className="block truncate text-sm text-muted-foreground tabular">
                        {formatDueDate(istanbulDayKey(e.startsAt), "d MMMM")} · {eventWhen(e)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Kişi başı açık iş" icon={Users}>
          {r.workload.length === 0 ? (
            <EmptyState compact icon={BarChart3} title="Üye yok" />
          ) : (
            <ul>
              {r.workload.map((w) => (
                <li key={w.userId} className="flex min-w-0 items-center gap-3 px-2 py-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{w.name}</span>
                  <Badge variant={w.openCount > 0 ? "secondary" : "outline"} className="tabular">
                    {w.openCount}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
