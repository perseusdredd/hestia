import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BellRing, CalendarDays, CheckCircle2, Circle, ListTodo, UserRound } from "lucide-react";

import { CommentThread } from "@/components/comments/comment-thread";
import { BookmarkToggle } from "@/components/bookmarks/bookmark-toggle";
import { SubscribeToggle } from "@/components/subscriptions/subscribe-toggle";
import { RichText } from "@/components/linkified-text";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDueDate, todayDateOnly } from "@/lib/date-only";
import { formatDateTime } from "@/lib/format";
import { toIstanbulInputValue } from "@/lib/istanbul-time";
import { requireWorkspace } from "@/lib/tenant";
import { getTodoItemDetail } from "@/server/todos";
import { isBookmarked } from "@/server/bookmarks";
import { isSubscribed, countSubscribers } from "@/server/subscriptions";
import { isServiceError } from "@/server/errors";

type Params = Promise<{ slug: string; itemId: string }>;

async function load(slug: string, itemId: string) {
  const { ctx } = await requireWorkspace(slug);
  try {
    return { ctx, item: await getTodoItemDetail(ctx, itemId) };
  } catch (e) {
    // A malformed id or one from another workspace is just a page that does not exist.
    if (isServiceError(e) && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, itemId } = await params;
  const { item } = await load(slug, itemId);
  return { title: item.title };
}

export default async function TodoItemPage({ params }: { params: Params }) {
  const { slug, itemId } = await params;
  const { ctx, item } = await load(slug, itemId);
  const subject = { type: "todo" as const, id: item.id };
  const [subscribed, subscribers, bookmarked] = await Promise.all([
    isSubscribed(ctx, subject),
    countSubscribers(ctx, subject),
    isBookmarked(ctx, subject),
  ]);
  const overdue = !item.done && item.dueDate !== null && item.dueDate < todayDateOnly();

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/w/${slug}/todos`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeft aria-hidden />
          Yapılacaklar
        </Link>
      </div>

      <div className="max-w-3xl space-y-5">
        <PageHeader
          title={<span className="block whitespace-normal break-words">{item.title}</span>}
          description={
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <ListTodo className="size-4" aria-hidden />
              <span className="break-words">{item.list.name}</span>
            </span>
          }
        />

        <Card>
          <CardContent className="space-y-4">
            <dl className="grid gap-4 text-sm sm:grid-cols-3">
              <div className="space-y-1">
                <dt className="text-xs text-muted-foreground">Durum</dt>
                <dd>
                  {item.done ? (
                    <Badge variant="secondary">
                      <CheckCircle2 aria-hidden />
                      Tamamlandı
                    </Badge>
                  ) : (
                    <Badge variant="outline">
                      <Circle aria-hidden />
                      Açık
                    </Badge>
                  )}
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="text-xs text-muted-foreground">Atanan kişi</dt>
                <dd className="flex min-w-0 items-center gap-2">
                  {item.assignee || item.extraAssignees.length > 0 ? (
                    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                      {[...(item.assignee ? [item.assignee] : []), ...item.extraAssignees].map((u) => (
                        <span key={u.id} className="inline-flex min-w-0 items-center gap-2">
                          <UserAvatar user={u} size="sm" />
                          <span className="truncate">{displayName(u)}</span>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <UserRound className="size-4" aria-hidden />
                      Atanmamış
                    </span>
                  )}
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="text-xs text-muted-foreground">Bitiş tarihi</dt>
                <dd className="flex items-center gap-1.5 tabular-nums">
                  {item.dueDate ? (
                    overdue ? (
                      <Badge variant="destructive">
                        <CalendarDays aria-hidden />
                        Gecikti: {formatDueDate(item.dueDate)}
                      </Badge>
                    ) : (
                      <>
                        <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
                        {formatDueDate(item.dueDate)}
                      </>
                    )
                  ) : (
                    <span className="text-muted-foreground">Yok</span>
                  )}
                </dd>
              </div>
              {item.startOn ? (
                <div className="space-y-1">
                  <dt className="text-xs text-muted-foreground">Başlangıç tarihi</dt>
                  <dd className="flex items-center gap-1.5 tabular-nums">
                    <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
                    {formatDueDate(item.startOn)}
                  </dd>
                </div>
              ) : null}
              {item.remindAt ? (
                <div className="space-y-1">
                  <dt className="text-xs text-muted-foreground">Hatırlatma</dt>
                  <dd className="flex items-center gap-1.5 tabular-nums">
                    <BellRing className="size-4 text-muted-foreground" aria-hidden />
                    {toIstanbulInputValue(new Date(item.remindAt), true).replace("T", " ")}
                  </dd>
                </div>
              ) : null}
              {item.sectionName ? (
                <div className="space-y-1">
                  <dt className="text-xs text-muted-foreground">Bölüm</dt>
                  <dd className="break-words">{item.sectionName}</dd>
                </div>
              ) : null}
            </dl>

            <div className="space-y-1">
              <h2 className="text-xs text-muted-foreground">Notlar</h2>
              {item.notes?.trim() ? (
                <RichText text={item.notes} />
              ) : (
                <p className="text-sm text-muted-foreground">Bu görev için not yok.</p>
              )}
            </div>

            <p className="flex flex-wrap items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
              <UserAvatar user={item.createdBy} size="sm" />
              <span>{displayName(item.createdBy)} oluşturdu</span>
              <span aria-hidden>·</span>
              <time dateTime={item.createdAt.toISOString()}>{formatDateTime(item.createdAt)}</time>
              {item.done && item.completedAt ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{formatDateTime(item.completedAt)} tamamlandı</span>
                </>
              ) : null}
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <BookmarkToggle slug={slug} subject={subject} bookmarked={bookmarked} />
          <SubscribeToggle slug={slug} subject={subject} subscribed={subscribed} count={subscribers} />
        </div>

        <p className="text-sm text-muted-foreground">
          Görevi düzenlemek veya tamamlamak için{" "}
          <Link href={`/w/${slug}/todos`} className="text-primary-text underline underline-offset-2 hover:no-underline">
            yapılacaklar listesine
          </Link>{" "}
          dönün.
        </p>
      </div>

      <CommentThread slug={slug} ctx={ctx} subject={{ type: "todo", id: item.id }} />
    </div>
  );
}
