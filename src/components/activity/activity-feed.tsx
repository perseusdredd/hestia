"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { loadMoreActivityAction, type ActivityPageState } from "@/app/w/[slug]/activity/actions";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDate, formatDateTime } from "@/lib/format";
import { istanbulDayKey } from "@/lib/istanbul-time";

import { activityMeta, DELETED_USER_LABEL, quotesSubject, type ActivityView } from "./activity-view";

type Day = { key: string; items: ActivityView[] };

function groupByDay(items: ActivityView[]): Day[] {
  const days: Day[] = [];
  for (const item of items) {
    const key = istanbulDayKey(new Date(item.createdAt));
    const last = days[days.length - 1];
    if (last && last.key === key) last.items.push(item);
    else days.push({ key, items: [item] });
  }
  return days;
}

function dayLabel(key: string, todayKey: string, yesterdayKey: string): string {
  if (key === todayKey) return "Bugün";
  if (key === yesterdayKey) return "Dün";
  // Noon UTC is the same Istanbul calendar day.
  return formatDate(`${key}T12:00:00Z`, "d MMMM yyyy, EEEE");
}

/**
 * One feed row. `timeText` overrides the default "HH:mm" label (the overview
 * passes a server-computed relative time so it cannot differ on hydration).
 */
export function ActivityRow({ slug, a, timeText }: { slug: string; a: ActivityView; timeText?: string }) {
  const meta = activityMeta(a.type);
  const Icon = meta.icon;
  const actorName = a.actor ? displayName(a.actor) : DELETED_USER_LABEL;
  const subjectText = quotesSubject(a.type) ? `“${a.title}”` : a.title;
  return (
    <li className="flex items-start gap-3 px-3 py-3">
      <span className="relative mt-0.5 shrink-0">
        {a.actor ? (
          <UserAvatar user={a.actor} size="sm" />
        ) : (
          <span className="flex size-6 rounded-full bg-muted" aria-hidden />
        )}
        <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-background ring-1 ring-border">
          <Icon className="size-2.5 text-muted-foreground" aria-hidden />
        </span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-3">
        <p className="min-w-0 flex-1 text-sm break-words">
          <span className={a.actor ? "font-medium" : "font-medium text-muted-foreground italic"}>{actorName}</span>{" "}
          {meta.before}
          {meta.subject ? (
            a.path ? (
              <Link
                href={`/w/${slug}/${a.path}`}
                className="rounded-sm font-medium underline-offset-4 hover:underline focus-visible:underline pointer-coarse:inline-block pointer-coarse:py-2"
              >
                {subjectText}
              </Link>
            ) : (
              <span className="font-medium">{subjectText}</span>
            )
          ) : null}
          {meta.after}
        </p>
        <time
          dateTime={a.createdAt}
          title={formatDateTime(a.createdAt)}
          className="shrink-0 text-xs text-muted-foreground tabular-nums sm:mt-0.5"
        >
          {timeText ?? formatDate(a.createdAt, "HH:mm")}
        </time>
      </div>
    </li>
  );
}

/**
 * Day-grouped feed. The first page comes from the server; "Daha fazla yükle"
 * appends the next pages (same filters) via a read-only server action.
 */
export function ActivityFeed({
  slug,
  initialItems,
  initialCursor,
  group,
  actorId,
  todayKey,
  yesterdayKey,
}: {
  slug: string;
  initialItems: ActivityView[];
  initialCursor: string | null;
  group: string;
  actorId: string;
  todayKey: string;
  yesterdayKey: string;
}) {
  const [state, action, pending] = useActionState<ActivityPageState, FormData>(
    loadMoreActivityAction.bind(null, slug),
    {},
  );
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [applied, setApplied] = useState<ActivityPageState>(state);
  // Append each newly loaded batch once (adjusting state while rendering).
  if (state !== applied) {
    setApplied(state);
    if (state.ok && state.items) {
      const seen = new Set(items.map((i) => i.id));
      setItems([...items, ...state.items.filter((i) => !seen.has(i.id))]);
      setCursor(state.nextCursor ?? null);
    }
  }

  const days = groupByDay(items);
  return (
    <div className="space-y-6">
      {days.map((day) => (
        <section key={day.key} aria-labelledby={`activity-day-${day.key}`} className="space-y-2">
          <h2 id={`activity-day-${day.key}`} className="text-sm font-medium text-muted-foreground">
            {dayLabel(day.key, todayKey, yesterdayKey)}
          </h2>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {day.items.map((a) => (
              <ActivityRow key={a.id} slug={slug} a={a} />
            ))}
          </ul>
        </section>
      ))}
      {cursor ? (
        <form action={action} className="grid justify-items-center gap-2">
          <input type="hidden" name="cursor" value={cursor} />
          <input type="hidden" name="group" value={group} />
          <input type="hidden" name="actor" value={actorId} />
          <SubmitButton variant="outline" pending={pending} pendingText="Yükleniyor">
            Daha fazla yükle
          </SubmitButton>
          {state.ok === false ? <FormError message={state.error} /> : null}
        </form>
      ) : null}
    </div>
  );
}
