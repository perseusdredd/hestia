import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarClock, Repeat, Users } from "lucide-react";
import { MapPin } from "lucide-react";

import { CommentThread } from "@/components/comments/comment-thread";
import { BookmarkToggle } from "@/components/bookmarks/bookmark-toggle";
import { SubscribeToggle } from "@/components/subscriptions/subscribe-toggle";
import { RichText } from "@/components/linkified-text";
import { InternalBadge } from "@/components/internal-toggle";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { eventWhen } from "@/lib/event-labels";
import { formatDateTime } from "@/lib/format";
import { istanbulDayKey } from "@/lib/istanbul-time";
import { requireWorkspace } from "@/lib/tenant";
import { RECURRENCE_LABELS, isRecurrence } from "@/lib/recurrence";
import { getEvent, listEventInviteeIds } from "@/server/calendar";
import { isServiceError } from "@/server/errors";
import { isBookmarked } from "@/server/bookmarks";
import { isSubscribed, countSubscribers } from "@/server/subscriptions";
import { listMemberUsers } from "@/server/workspaces";

type Params = Promise<{ slug: string; eventId: string }>;

async function load(slug: string, eventId: string) {
  const { ctx } = await requireWorkspace(slug);
  // Ids are cuids; anything longer is a page that does not exist.
  if (eventId.length > 64) notFound();
  try {
    return { ctx, event: await getEvent(ctx, eventId) };
  } catch (e) {
    if (isServiceError(e) && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, eventId } = await params;
  const { event } = await load(slug, eventId);
  return { title: event.title };
}

export default async function EventPage({ params }: { params: Params }) {
  const { slug, eventId } = await params;
  const { ctx, event } = await load(slug, eventId);
  const subject = { type: "event" as const, id: event.id };
  const [members, subscribed, subscribers, bookmarked, inviteeIds] = await Promise.all([
    listMemberUsers(ctx),
    isSubscribed(ctx, subject),
    countSubscribers(ctx, subject),
    isBookmarked(ctx, subject),
    listEventInviteeIds(ctx, event.id),
  ]);
  const invitees = inviteeIds.flatMap((id) => members.find((m) => m.id === id) ?? []);
  const creator = members.find((m) => m.id === event.createdById) ?? null;
  const dayKey = istanbulDayKey(event.startsAt);
  const calendarHref = `/w/${slug}/calendar?month=${dayKey.slice(0, 7)}#agenda-${dayKey}`;

  return (
    <div className="space-y-6">
      <div>
        <Link href={calendarHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeft aria-hidden />
          Takvim
        </Link>
      </div>

      <div className="max-w-3xl space-y-5">
        <PageHeader
          title={
            <span className="flex flex-wrap items-center gap-2 whitespace-normal break-words">
              {event.title}
              {event.internal ? <InternalBadge /> : null}
            </span>
          }
          description={
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <CalendarClock className="size-4" aria-hidden />
              <span>{eventWhen(event)}</span>
              {event.recurrence !== "NONE" && isRecurrence(event.recurrence) ? (
                <>
                  <Repeat className="ml-2 size-4" aria-hidden />
                  <span>
                    {RECURRENCE_LABELS[event.recurrence]}
                    {event.recurrenceUntil ? ` · ${istanbulDayKey(event.recurrenceUntil)} tarihine kadar` : ""}
                  </span>
                </>
              ) : null}
            </span>
          }
        />

        <Card>
          <CardContent className="space-y-4">
            {event.location ? (
              <p className="flex items-start gap-1.5 text-sm">
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 break-words">{event.location}</span>
              </p>
            ) : null}
            {invitees.length > 0 ? (
              <div className="space-y-1.5">
                <h2 className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="size-3.5" aria-hidden />
                  Davetliler ({invitees.length})
                </h2>
                <ul className="flex flex-wrap gap-2">
                  {invitees.map((m) => (
                    <li key={m.id} className="flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-sm">
                      <UserAvatar user={m} size="sm" />
                      <span className="min-w-0 truncate">{displayName(m)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="space-y-1">
              <h2 className="text-xs text-muted-foreground">Açıklama</h2>
              {event.description?.trim() ? (
                <RichText text={event.description} />
              ) : (
                <p className="text-sm text-muted-foreground">Bu etkinlik için açıklama yok.</p>
              )}
            </div>
            <p className="flex flex-wrap items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
              {creator ? (
                <>
                  <UserAvatar user={creator} size="sm" />
                  <span>{displayName(creator)} ekledi</span>
                  <span aria-hidden>·</span>
                </>
              ) : null}
              <time dateTime={event.createdAt.toISOString()}>{formatDateTime(event.createdAt)}</time>
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <BookmarkToggle slug={slug} subject={subject} bookmarked={bookmarked} />
          <SubscribeToggle slug={slug} subject={subject} subscribed={subscribed} count={subscribers} />
        </div>

        <p className="text-sm text-muted-foreground">
          Etkinliği düzenlemek için{" "}
          <Link href={calendarHref} className="text-primary-text underline underline-offset-2 hover:no-underline">
            takvime
          </Link>{" "}
          dönün.
        </p>
      </div>

      <CommentThread slug={slug} ctx={ctx} subject={{ type: "event", id: event.id }} />
    </div>
  );
}
