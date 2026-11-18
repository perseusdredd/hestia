import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  CalendarDays,
  CheckSquare,
  FolderOpen,
  MessageSquare,
  MessagesSquare,
  Pin,
  Users,
  type LucideIcon,
} from "lucide-react";

import { documentHref, fileViewHref } from "@/app/w/[slug]/files/paths";
import { ActivityRow } from "@/components/activity/activity-feed";
import { toActivityView } from "@/components/activity/activity-view";
import { EmptyState } from "@/components/empty-state";
import { formatBytes, ItemIcon } from "@/components/files/file-meta";
import { PageHeader } from "@/components/page-header";
import { workspaceHref } from "@/components/shell/nav-items";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDueDate, todayDateOnly } from "@/lib/date-only";
import { eventWhen } from "@/lib/event-labels";
import { formatDate, formatRelative } from "@/lib/format";
import { istanbulDayKey } from "@/lib/istanbul-time";
import { requireWorkspace } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { listActivity } from "@/server/activity";
import { listUpcomingEvents } from "@/server/calendar";
import { listRecentItems } from "@/server/files";
import { listPosts } from "@/server/messages";
import { getOverviewCounts } from "@/server/overview";
import { listMyOpenTodos } from "@/server/todos";
import { getWorkspaceSummary } from "@/server/workspaces";

const UPCOMING_DAYS = 14;

function Section({
  title,
  icon: Icon,
  href,
  linkLabel,
  className,
  children,
}: {
  title: string;
  icon: LucideIcon;
  href: string;
  linkLabel: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn("flex min-w-0 flex-col rounded-xl border bg-card shadow-xs", className)}
      aria-label={title}
    >
      <header className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-1.5">
        <h2 className="flex items-center gap-2 text-section-title">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          {title}
        </h2>
        <Link
          href={href}
          className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-primary-text focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:-my-2.5 pointer-coarse:min-h-10"
        >
          {linkLabel}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </header>
      <div className="flex-1 px-2 pt-1 pb-2">{children}</div>
    </section>
  );
}

function Stat({
  href,
  icon: Icon,
  value,
  label,
  tone,
}: {
  href: string;
  icon: LucideIcon;
  value: number;
  label: string;
  tone?: "warn";
}) {
  return (
    <li className="min-w-0">
      <Link
        href={href}
        className="flex h-full min-h-14 items-center gap-3 rounded-xl border bg-card px-3.5 py-2.5 shadow-xs transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Icon
          className={cn("size-4 shrink-0", tone === "warn" && value > 0 ? "text-destructive" : "text-muted-foreground")}
          aria-hidden
        />
        <span className="min-w-0">
          <span
            className={cn(
              "block text-xl leading-tight font-semibold tabular-nums",
              tone === "warn" && value > 0 && "text-destructive",
            )}
          >
            {value}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{label}</span>
        </span>
      </Link>
    </li>
  );
}

const rowClass =
  "flex min-w-0 items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

export default async function WorkspaceOverview({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const today = todayDateOnly();

  const [summary, counts, posts, todos, events, recent, activity] = await Promise.all([
    getWorkspaceSummary(ctx),
    getOverviewCounts(ctx, { today }),
    listPosts(ctx, { take: 5, includeDrafts: false }),
    listMyOpenTodos(ctx, { today, take: 6 }),
    listUpcomingEvents(ctx, { days: UPCOMING_DAYS, take: 6 }),
    listRecentItems(ctx, { take: 6 }),
    listActivity(ctx, { take: 5 }),
  ]);

  const href = (segment: string) => workspaceHref(summary.slug, segment);

  return (
    <div className="space-y-6 sm:space-y-8">
      <PageHeader
        title={summary.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <Users className="size-3.5" aria-hidden />
              {summary.memberCount} üye
            </span>
            <span className="tabular">{formatDate(summary.createdAt)} tarihinde oluşturuldu</span>
          </span>
        }
        actions={
          <Link href={href("chat")} className={buttonVariants({ variant: "outline" })}>
            <MessagesSquare aria-hidden />
            Sohbete git
          </Link>
        }
      />

      <ul aria-label="Özet" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat href={href("todos")} icon={CheckSquare} value={counts.openTodos} label="Açık görev" />
        <Stat href={href("todos")} icon={AlertTriangle} value={counts.overdueTodos} label="Geciken görev" tone="warn" />
        <Stat href={href("calendar")} icon={CalendarDays} value={counts.eventsThisWeek} label="Bu haftaki etkinlik" />
        <Stat href={href("notifications")} icon={Bell} value={counts.unreadNotifications} label="Okunmamış bildirim" />
      </ul>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Son mesajlar" icon={MessageSquare} href={href("messages")} linkLabel="Tümü">
          {posts.items.length === 0 ? (
            <EmptyState
              compact
              icon={MessageSquare}
              title="Henüz mesaj yok"
              description="Ekibe bir duyuru veya güncelleme yazarak başlayın."
              action={
                <Link href={href("messages/new")} className={buttonVariants({ size: "sm" })}>
                  Mesaj yaz
                </Link>
              }
            />
          ) : (
            <ul>
              {posts.items.map((p) => (
                <li key={p.id}>
                  <Link href={href(`messages/${p.id}`)} className={rowClass}>
                    <UserAvatar user={p.author} size="sm" className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        {p.pinned ? (
                          <Pin className="size-3.5 shrink-0 text-primary-text" aria-label="Sabitlenmiş" />
                        ) : null}
                        <span className="truncate font-medium">{p.title}</span>
                      </span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {displayName(p.author)} · {formatRelative(p.createdAt)}
                        {p.commentCount > 0 ? ` · ${p.commentCount} yorum` : ""}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Bana atanan işler"
          icon={CheckSquare}
          href={`${href("todos")}?mine=1`}
          linkLabel={todos.total > todos.items.length ? `Tümü (${todos.total})` : "Tümü"}
        >
          {todos.items.length === 0 ? (
            <EmptyState
              compact
              icon={CheckSquare}
              title="Size atanmış açık iş yok"
              description="Yeni işler size atandığında burada görünür."
              action={
                <Link href={href("todos")} className={buttonVariants({ size: "sm", variant: "outline" })}>
                  Listelere git
                </Link>
              }
            />
          ) : (
            <ul>
              {todos.items.map((t) => (
                <li key={t.id}>
                  <Link href={href(`todos/${t.id}`)} className={rowClass}>
                    <span
                      className="mt-1 size-4 shrink-0 rounded-[5px] border border-input"
                      aria-hidden
                    />
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
          )}
        </Section>

        <Section
          title={`Yaklaşan etkinlikler (${UPCOMING_DAYS} gün)`}
          icon={CalendarDays}
          href={href("calendar")}
          linkLabel="Takvim"
        >
          {events.length === 0 ? (
            <EmptyState
              compact
              icon={CalendarDays}
              title="Önümüzdeki iki haftada etkinlik yok"
              description="Toplantıları ve önemli tarihleri takvime ekleyin."
              action={
                <Link href={href("calendar")} className={buttonVariants({ size: "sm", variant: "outline" })}>
                  Takvime git
                </Link>
              }
            />
          ) : (
            <ul>
              {events.map((e) => (
                <li key={e.id}>
                  <Link
                    href={`${href("calendar")}?month=${istanbulDayKey(e.startsAt).slice(0, 7)}`}
                    className={rowClass}
                  >
                    <span className="flex w-11 shrink-0 flex-col items-center rounded-lg border bg-background py-1 text-center leading-tight">
                      <span className="text-base font-semibold tabular-nums">
                        {formatDueDate(istanbulDayKey(e.startsAt), "d")}
                      </span>
                      <span className="text-[11px] font-medium text-primary-text uppercase">
                        {formatDueDate(istanbulDayKey(e.startsAt), "MMM")}
                      </span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{e.title}</span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {eventWhen(e)}
                        {e.location ? ` · ${e.location}` : ""}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Son dosyalar" icon={FolderOpen} href={href("files")} linkLabel="Dosyalar">
          {recent.length === 0 ? (
            <EmptyState
              compact
              icon={FolderOpen}
              title="Henüz dosya yok"
              description="Dosya yükleyin veya bir doküman oluşturun."
              action={
                <Link href={href("files")} className={buttonVariants({ size: "sm", variant: "outline" })}>
                  Dosyalara git
                </Link>
              }
            />
          ) : (
            <ul>
              {recent.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  {item.kind === "file" ? (
                    <Link href={fileViewHref(summary.slug, item.id)} className={rowClass}>
                      <ItemIcon kind="file" mimeType={item.mimeType} name={item.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{item.name}</span>
                        <span className="block truncate text-sm text-muted-foreground">
                          {formatBytes(item.size)} · {displayName(item.by)} · {formatRelative(item.at)}
                        </span>
                      </span>
                    </Link>
                  ) : (
                    <Link href={documentHref(summary.slug, item.id)} className={rowClass}>
                      <ItemIcon kind="document" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{item.name}</span>
                        <span className="block truncate text-sm text-muted-foreground">
                          Doküman · {displayName(item.by)} · {formatRelative(item.at)} düzenlendi
                        </span>
                      </span>
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Son hareketler"
          icon={Activity}
          href={href("activity")}
          linkLabel="Tümü"
          className="lg:col-span-2"
        >
          {activity.items.length === 0 ? (
            <EmptyState
              compact
              icon={Activity}
              title="Henüz hareket yok"
              description="Ekipteki paylaşımlar, görevler ve dosyalar burada listelenir."
            />
          ) : (
            <ul className="divide-y">
              {activity.items.map((a) => (
                <ActivityRow
                  key={a.id}
                  slug={summary.slug}
                  a={toActivityView(a)}
                  timeText={formatRelative(a.createdAt)}
                />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
