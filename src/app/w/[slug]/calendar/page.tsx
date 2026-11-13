import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { tr } from "date-fns/locale";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { CalendarView } from "@/components/calendar/calendar-view";
import type { CalDay, CalEvent } from "@/components/calendar/types";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { requireWorkspace } from "@/lib/tenant";
import { listMonth } from "@/server/calendar";
import { countComments } from "@/server/comments";
import {
  eventDayKeys,
  isMonthParam,
  istanbulDayKey,
  istanbulTime,
  keyToCalendarDate,
  shiftMonth,
  toIstanbulInputValue,
} from "@/lib/istanbul-time";

export const metadata: Metadata = { title: "Takvim" };

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ month?: string | string[] }>;
}) {
  const { slug } = await params;
  const { month: monthParam } = await searchParams;
  const { ctx } = await requireWorkspace(slug);

  const todayKey = istanbulDayKey(new Date());
  const currentMonth = todayKey.slice(0, 7);
  const raw = Array.isArray(monthParam) ? monthParam[0] : monthParam;
  const month = isMonthParam(raw) ? raw : currentMonth;

  const { grid, events, todos } = await listMonth(ctx, month);
  const commentCounts = await countComments(
    ctx,
    "event",
    events.map((e) => e.id),
  );

  const calEvents: CalEvent[] = events.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description ?? "",
    location: e.location ?? "",
    allDay: e.allDay,
    start: toIstanbulInputValue(e.startsAt, !e.allDay),
    end: toIstanbulInputValue(e.endsAt, !e.allDay),
    startTime: e.allDay ? null : istanbulTime(e.startsAt),
    endTime: e.allDay ? null : istanbulTime(e.endsAt),
    startKey: istanbulDayKey(e.startsAt),
    endKey: istanbulDayKey(e.endsAt),
    canEdit: e.canEdit,
    commentCount: commentCounts[e.id] ?? 0,
  }));

  const eventsByDay = new Map<string, string[]>();
  for (const e of events) {
    for (const key of eventDayKeys(e.startsAt, e.endsAt)) {
      const list = eventsByDay.get(key) ?? [];
      list.push(e.id);
      eventsByDay.set(key, list);
    }
  }
  const todosByDay = new Map<string, CalDay["todos"]>();
  for (const t of todos) {
    if (!t.dueDate) continue;
    const key = t.dueDate.toISOString().slice(0, 10);
    const list = todosByDay.get(key) ?? [];
    list.push({ id: t.id, title: t.title, done: t.status === "DONE" });
    todosByDay.set(key, list);
  }

  const days: CalDay[] = grid.days.map((key) => ({
    key,
    inMonth: key.startsWith(month),
    isToday: key === todayKey,
    eventIds: eventsByDay.get(key) ?? [],
    todos: todosByDay.get(key) ?? [],
  }));

  const base = `/w/${slug}/calendar`;
  const label = format(keyToCalendarDate(`${month}-01`), "LLLL yyyy", { locale: tr });
  const defaultDayKey = month === currentMonth ? todayKey : `${month}-01`;

  return (
    <div className="space-y-6">
      <PageHeader title="Takvim" description="Etkinlikler ve yapılacakların son tarihleri." />
      <CalendarView
        key={month}
        slug={slug}
        days={days}
        events={calEvents}
        todayKey={todayKey}
        defaultDayKey={defaultDayKey}
        toolbar={
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <h2 className="text-lg font-semibold capitalize tabular-nums" aria-live="polite">
              {label}
            </h2>
            <nav aria-label="Ay gezintisi" className="flex items-center gap-1.5">
              <Link
                href={`${base}?month=${shiftMonth(month, -1)}`}
                className={buttonVariants({ variant: "outline", size: "icon" })}
                aria-label="Önceki ay"
              >
                <ChevronLeft aria-hidden />
              </Link>
              <Link
                href={base}
                className={buttonVariants({ variant: "outline" })}
                aria-current={month === currentMonth ? "date" : undefined}
              >
                Bugün
              </Link>
              <Link
                href={`${base}?month=${shiftMonth(month, 1)}`}
                className={buttonVariants({ variant: "outline", size: "icon" })}
                aria-label="Sonraki ay"
              >
                <ChevronRight aria-hidden />
              </Link>
            </nav>
          </div>
        }
      />
    </div>
  );
}
