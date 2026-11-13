/** Pure label helpers for calendar events (agenda + overview). Unit-tested in tests/calendar.test.ts. */
import { formatDueDate } from "@/lib/date-only";
import { istanbulDayKey, istanbulTime } from "@/lib/istanbul-time";

type AgendaEvent = {
  allDay: boolean;
  startKey: string;
  endKey: string;
  startTime: string | null;
  endTime: string | null;
};

/**
 * Agenda label for `e` on `dayKey`. A multi-day timed event shows its start
 * time on the first day, its end time on the last and "Tüm gün" in between.
 */
export function agendaTimeLabel(e: AgendaEvent, dayKey: string = e.startKey): string {
  if (e.allDay) return "Tüm gün";
  if (e.startKey !== e.endKey) {
    if (dayKey === e.startKey) return `${e.startTime ?? ""} →`;
    if (dayKey === e.endKey) return `→ ${e.endTime ?? ""}`;
    return "Tüm gün";
  }
  return e.endTime && e.endTime !== e.startTime ? `${e.startTime} - ${e.endTime}` : (e.startTime ?? "");
}

/** Overview "when" line; multi-day events name their end date too. */
export function eventWhen(e: { startsAt: Date; endsAt: Date; allDay: boolean }): string {
  const startKey = istanbulDayKey(e.startsAt);
  const endKey = istanbulDayKey(e.endsAt);
  const day = formatDueDate(startKey, "d MMMM EEEE");
  if (e.allDay) {
    return startKey === endKey ? `${day} · Tüm gün` : `${day} – ${formatDueDate(endKey, "d MMMM")}`;
  }
  const start = istanbulTime(e.startsAt);
  const end = istanbulTime(e.endsAt);
  if (startKey !== endKey) return `${day} ${start} – ${formatDueDate(endKey, "d MMMM")} ${end}`;
  return `${day} · ${start}–${end}`;
}
