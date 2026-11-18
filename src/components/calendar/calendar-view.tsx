"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { tr } from "date-fns/locale";
import { CalendarClock, CheckSquare, MapPin, MessageCircle, Plus } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { agendaTimeLabel } from "@/lib/event-labels";
import { keyToCalendarDate } from "@/lib/istanbul-time";

import type { ProjectOption } from "@/components/project-select";
import { EventDialog, type DialogTarget } from "./event-dialog";
import type { CalDay, CalEvent, CalMember } from "./types";

const WEEKDAYS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
const MAX_CHIPS = 3;
const MAX_PHONE_BARS = 2;

export function CalendarView({
  slug,
  days,
  events,
  members,
  projects = [],
  todayKey,
  defaultDayKey,
  toolbar,
}: {
  slug: string;
  days: CalDay[];
  events: CalEvent[];
  /** Workspace members, for the invitee picker. */
  members: CalMember[];
  /** Active projects, offered when creating an event. */
  projects?: ProjectOption[];
  todayKey: string;
  /** Day pre-filled by the "Yeni etkinlik" button (today if in this month, else the 1st). */
  defaultDayKey: string;
  /** Month label and navigation, shown left of the "Yeni etkinlik" button. */
  toolbar?: React.ReactNode;
}) {
  const [rawTarget, setTarget] = useState<DialogTarget>(null);
  const close = useCallback(() => setTarget(null), []);
  // Keyed per occurrence: a recurring event appears once per day it falls on.
  const byId = useMemo(() => new Map(events.map((e) => [e.key, e])), [events]);
  const eventIds = useMemo(() => new Set(events.map((e) => e.id)), [events]);
  // An event deleted (here or by someone else) closes its dialog on the next refresh.
  const target = rawTarget?.mode === "edit" && !eventIds.has(rawTarget.event.id) ? null : rawTarget;
  const agenda = days.filter((d) => d.inMonth && (d.eventIds.length > 0 || d.todos.length > 0));
  const todosHref = `/w/${slug}/todos`;

  // Roving tabindex: the 42 day buttons are ONE tab stop; arrows move between
  // days (Left/Right a day, Up/Down a week, Home/End the week's ends).
  const gridRef = useRef<HTMLDivElement>(null);
  const initialFocus = days.some((d) => d.key === defaultDayKey) ? defaultDayKey : (days[0]?.key ?? "");
  const [focusKey, setFocusKey] = useState(initialFocus);
  const activeKey = days.some((d) => d.key === focusKey) ? focusKey : initialFocus;

  function onDayKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (e.key === "ArrowRight") next = index + 1;
    else if (e.key === "ArrowLeft") next = index - 1;
    else if (e.key === "ArrowDown") next = index + 7;
    else if (e.key === "ArrowUp") next = index - 7;
    else if (e.key === "Home") next = index - (index % 7);
    else if (e.key === "End") next = index - (index % 7) + 6;
    else return;
    e.preventDefault();
    if (next < 0 || next >= days.length) return;
    const key = days[next].key;
    setFocusKey(key);
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${key}"]`)?.focus();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {toolbar}
        <Button className="ml-auto" onClick={() => setTarget({ mode: "create", dayKey: defaultDayKey })}>
          <Plus aria-hidden />
          Yeni etkinlik
        </Button>
      </div>

      <section
        aria-label="Ay görünümü"
        aria-describedby="calendar-keys-hint"
        className="overflow-hidden rounded-xl border bg-card"
      >
        <p id="calendar-keys-hint" className="sr-only">
          Günler arasında ok tuşlarıyla gezinin; Enter seçili güne etkinlik ekler.
        </p>
        <div className="grid grid-cols-7 border-b text-center text-xs font-medium text-muted-foreground" aria-hidden>
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-2">
              {w}
            </div>
          ))}
        </div>
        <div ref={gridRef} className="grid grid-cols-7">
          {days.map((day, i) => {
            const date = keyToCalendarDate(day.key);
            const dayEvents = day.eventIds.map((id) => byId.get(id)).filter((e): e is CalEvent => !!e);
            const shown = dayEvents.slice(0, MAX_CHIPS);
            const extra = dayEvents.length - shown.length + day.todos.length;
            return (
              <div
                key={day.key}
                className={cn(
                  "min-h-[4.5rem] min-w-0 border-b border-r p-0.5 sm:min-h-28 sm:p-1.5",
                  i % 7 === 6 && "border-r-0",
                  i >= days.length - 7 && "border-b-0",
                  !day.inMonth && "bg-muted/50 text-muted-foreground",
                )}
              >
                <button
                  type="button"
                  data-day={day.key}
                  tabIndex={day.key === activeKey ? 0 : -1}
                  onKeyDown={(e) => onDayKeyDown(e, i)}
                  onFocus={() => setFocusKey(day.key)}
                  onClick={() => setTarget({ mode: "create", dayKey: day.key })}
                  aria-label={`${format(date, "d MMMM EEEE", { locale: tr })} için etkinlik ekle`}
                  className={cn(
                    "mx-auto flex size-6 items-center justify-center rounded-full text-xs font-medium pointer-coarse:size-10 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 sm:mx-0 sm:size-7 sm:text-sm",
                    day.isToday && "bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                  aria-current={day.isToday ? "date" : undefined}
                >
                  {format(date, "d")}
                </button>

                {/* Phones: short title bars (the agenda below has the details and the controls). */}
                <div className="mt-1 space-y-0.5 sm:hidden" aria-hidden>
                  {dayEvents.slice(0, MAX_PHONE_BARS).map((e) => (
                    <span
                      key={e.key}
                      className="block truncate rounded-[3px] bg-primary-soft px-1 text-[10px] leading-[15px] font-medium text-primary-text"
                    >
                      {e.title}
                    </span>
                  ))}
                  {dayEvents.length + day.todos.length > MAX_PHONE_BARS ? (
                    <span className="block px-1 text-[10px] leading-[14px] text-muted-foreground tabular-nums">
                      +{dayEvents.length + day.todos.length - Math.min(dayEvents.length, MAX_PHONE_BARS)}
                    </span>
                  ) : day.todos.length > 0 ? (
                    <span className="block truncate rounded-[3px] bg-muted px-1 text-[10px] leading-[15px] text-muted-foreground">
                      {day.todos.length} görev
                    </span>
                  ) : null}
                </div>

                <div className="mt-1 hidden space-y-0.5 sm:block">
                  {shown.map((e) => (
                    <button
                      key={e.key}
                      type="button"
                      onClick={() => setTarget({ mode: "edit", event: e })}
                      title={e.title}
                      className="block w-full truncate rounded bg-primary-soft px-1.5 py-0.5 text-left text-xs font-medium text-primary-text outline-none hover:bg-primary/20 focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {!e.allDay && e.startKey === day.key ? (
                        <span className="mr-1 font-normal">{e.startTime}</span>
                      ) : null}
                      {e.title}
                    </button>
                  ))}
                  {extra > 0 ? (
                    <a
                      href="#agenda"
                      className="block px-1.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      +{extra} daha
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section id="agenda" aria-label="Ajanda" className="scroll-mt-20 space-y-3">
        <h2 className="text-section-title">Ajanda</h2>
        {agenda.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="Bu ay için etkinlik yok"
            description="Yeni bir etkinlik ekleyin ya da başka bir aya göz atın."
            action={
              <Button variant="outline" onClick={() => setTarget({ mode: "create", dayKey: defaultDayKey })}>
                <Plus aria-hidden />
                Yeni etkinlik
              </Button>
            }
          />
        ) : (
          <ol className="divide-y rounded-xl border bg-card">
            {agenda.map((day) => {
              const date = keyToCalendarDate(day.key);
              return (
                <li key={day.key} id={`agenda-${day.key}`} className="flex gap-3 p-3 sm:gap-4 sm:p-4">
                  <div className="w-12 shrink-0 text-center">
                    <div className="text-xs uppercase text-muted-foreground">
                      {format(date, "EEE", { locale: tr })}
                    </div>
                    <div
                      className={cn(
                        "mx-auto flex size-8 items-center justify-center rounded-full text-base font-semibold",
                        day.key === todayKey && "bg-primary text-primary-foreground",
                      )}
                    >
                      {format(date, "d")}
                    </div>
                  </div>
                  <ul className="min-w-0 flex-1 space-y-2">
                    {day.eventIds.map((id) => {
                      const e = byId.get(id);
                      if (!e) return null;
                      return (
                        <li key={id}>
                          <button
                            type="button"
                            onClick={() => setTarget({ mode: "edit", event: e })}
                            className="w-full rounded-lg px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            <span className="block text-xs text-muted-foreground">{agendaTimeLabel(e, day.key)}</span>
                            <span className="block break-words text-sm font-medium">{e.title}</span>
                            {e.location ? (
                              <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                                <MapPin className="size-3 shrink-0" aria-hidden />
                                <span className="break-all">{e.location}</span>
                              </span>
                            ) : null}
                            {e.commentCount > 0 ? (
                              <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                                <MessageCircle className="size-3 shrink-0" aria-hidden />
                                {e.commentCount} yorum
                              </span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                    {day.todos.map((t) => (
                      <li key={t.id}>
                        <Link
                          href={todosHref}
                          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          <CheckSquare className="size-4 shrink-0" aria-hidden />
                          <span className={cn("min-w-0 break-words", t.done && "line-through")}>
                            {t.title}
                          </span>
                          <span className="ml-auto shrink-0 text-xs">Son tarih</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <EventDialog slug={slug} target={target} members={members} projects={projects} onClose={close} />
    </div>
  );
}
