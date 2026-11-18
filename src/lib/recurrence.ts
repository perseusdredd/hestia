import { addMonths, format } from "date-fns";

import { addDaysToKey, istanbulDayKey, istanbulDayStart, keyToCalendarDate } from "@/lib/istanbul-time";

/** Pure recurrence helpers (client-safe). Istanbul is a fixed UTC+3 zone, so wall time never shifts. */
export const RECURRENCES = ["NONE", "DAILY", "WEEKLY", "MONTHLY"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export const RECURRENCE_LABELS: Record<Recurrence, string> = {
  NONE: "Tekrar etmez",
  DAILY: "Her gün",
  WEEKLY: "Her hafta",
  MONTHLY: "Her ay",
};

/** Upper bound on generated occurrences per event per expansion (runaway guard). */
export const MAX_OCCURRENCES = 1500;

export function isRecurrence(value: unknown): value is Recurrence {
  return typeof value === "string" && (RECURRENCES as readonly string[]).includes(value);
}

export type RecurringShape = {
  startsAt: Date;
  endsAt: Date;
  recurrence: string;
  recurrenceUntil: Date | null;
};

export type Occurrence = { startsAt: Date; endsAt: Date; index: number };

/** Day key of the nth occurrence (n >= 0). Monthly clamps to the month's last day (31st -> 30th/28th). */
function occurrenceDayKey(startKey: string, recurrence: Recurrence, n: number): string {
  if (recurrence === "DAILY") return addDaysToKey(startKey, n);
  if (recurrence === "WEEKLY") return addDaysToKey(startKey, 7 * n);
  return format(addMonths(keyToCalendarDate(startKey), n), "yyyy-MM-dd");
}

/**
 * Occurrences of `event` whose time span overlaps [rangeStart, rangeEnd], ascending.
 * A non-recurring (or unknown-recurrence) event yields itself when it overlaps.
 * Stops at recurrenceUntil (an occurrence may start on or before it) or MAX_OCCURRENCES.
 */
export function expandOccurrences(event: RecurringShape, rangeStart: Date, rangeEnd: Date): Occurrence[] {
  const overlaps = (s: Date, e: Date) => s.getTime() <= rangeEnd.getTime() && e.getTime() >= rangeStart.getTime();
  if (!isRecurrence(event.recurrence) || event.recurrence === "NONE") {
    return overlaps(event.startsAt, event.endsAt) ? [{ startsAt: event.startsAt, endsAt: event.endsAt, index: 0 }] : [];
  }
  const startKey = istanbulDayKey(event.startsAt);
  const startDayMs = istanbulDayStart(startKey).getTime();
  const offsetMs = event.startsAt.getTime() - startDayMs; // time of day
  const durationMs = event.endsAt.getTime() - event.startsAt.getTime();
  const untilMs = event.recurrenceUntil?.getTime() ?? Infinity;
  const out: Occurrence[] = [];
  for (let n = 0; n < MAX_OCCURRENCES; n++) {
    const startMs = istanbulDayStart(occurrenceDayKey(startKey, event.recurrence, n)).getTime() + offsetMs;
    if (startMs > rangeEnd.getTime() || startMs > untilMs) break;
    if (startMs + durationMs >= rangeStart.getTime()) {
      out.push({ startsAt: new Date(startMs), endsAt: new Date(startMs + durationMs), index: n });
    }
  }
  return out;
}
