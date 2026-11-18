import Link from "next/link";
import { AlertTriangle, BellRing, CalendarDays, CheckSquare, FileText, type LucideIcon } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { workspaceHref } from "@/components/shell/nav-items";
import { Badge } from "@/components/ui/badge";
import { formatDueDate, todayDateOnly } from "@/lib/date-only";
import { eventWhen } from "@/lib/event-labels";
import { formatRelative } from "@/lib/format";
import { istanbulDayKey } from "@/lib/istanbul-time";
import { requireWorkspace } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { getMyWork, MY_EVENT_DAYS } from "@/server/my-work";
import type { MyOpenTodo } from "@/server/todos";

export const metadata = { title: "Benim İşlerim" };

const rowClass =
  "flex min-w-0 items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
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

const SUBJECT_LABEL = { post: "Mesaj", todo: "Görev", event: "Etkinlik" } as const;
const SUBJECT_PATH = { post: "messages", todo: "todos", event: "calendar" } as const;

export default async function MyWorkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const today = todayDateOnly();
  const work = await getMyWork(ctx, { today });
  const href = (segment: string) => workspaceHref(slug, segment);

  const groups: { key: keyof typeof work.todos; label: string; items: MyOpenTodo[] }[] = [
    { key: "overdue", label: "Gecikmiş", items: work.todos.overdue },
    { key: "today", label: "Bugün", items: work.todos.today },
    { key: "upcoming", label: "Yaklaşan", items: work.todos.upcoming },
    { key: "undated", label: "Tarihsiz", items: work.todos.undated },
  ];
  const hasTodos = groups.some((g) => g.items.length > 0);

  return (
    <div className="space-y-6 sm:space-y-8">
      <PageHeader title="Benim İşlerim" description="Size atanan işler, etkinlikler, taslaklar ve takip ettikleriniz." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={`Açık işlerim (${work.todoTotal})`} icon={CheckSquare}>
          {!hasTodos ? (
            <EmptyState compact icon={CheckSquare} title="Size atanmış açık iş yok" />
          ) : (
            <div className="space-y-3">
              {groups
                .filter((g) => g.items.length > 0)
                .map((g) => (
                  <div key={g.key}>
                    <h3
                      className={cn(
                        "flex items-center gap-1.5 px-2 pb-1 text-xs font-medium text-muted-foreground",
                        g.key === "overdue" && "text-destructive",
                      )}
                    >
                      {g.key === "overdue" ? <AlertTriangle className="size-3.5" aria-hidden /> : null}
                      {g.label} ({g.items.length})
                    </h3>
                    <ul>
                      {g.items.map((t) => (
                        <li key={t.id}>
                          <Link href={href(`todos/${t.id}`)} className={rowClass}>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{t.title}</span>
                              <span className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                                <span className="truncate">{t.listName}</span>
                                {t.dueDate ? (
                                  <span className={cn("tabular", t.overdue && "text-destructive")}>
                                    · {formatDueDate(t.dueDate, "d MMMM")}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                            {t.overdue ? <Badge variant="destructive">Gecikti</Badge> : null}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          )}
        </Section>

        <Section title={`Yaklaşan etkinlikler (${MY_EVENT_DAYS} gün)`} icon={CalendarDays}>
          {work.events.length === 0 ? (
            <EmptyState compact icon={CalendarDays} title="Yaklaşan etkinlik yok" />
          ) : (
            <ul>
              {work.events.map((e) => (
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

        <Section title="Taslaklarım" icon={FileText}>
          {work.drafts.length === 0 ? (
            <EmptyState compact icon={FileText} title="Yayınlanmamış taslağınız yok" />
          ) : (
            <ul>
              {work.drafts.map((d) => (
                <li key={d.id}>
                  <Link href={href(`messages/${d.id}`)} className={rowClass}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{d.title}</span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {formatRelative(d.updatedAt)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Takip ettiklerim" icon={BellRing}>
          {work.subscriptions.length === 0 ? (
            <EmptyState compact icon={BellRing} title="Takip ettiğiniz bir kayıt yok" />
          ) : (
            <ul>
              {work.subscriptions.map((s) => (
                <li key={`${s.type}-${s.id}`}>
                  <Link href={href(`${SUBJECT_PATH[s.type]}/${s.id}`)} className={rowClass}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{s.title}</span>
                      <span className="block truncate text-sm text-muted-foreground">{SUBJECT_LABEL[s.type]}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
