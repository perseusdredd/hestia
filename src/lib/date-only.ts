import { format, isValid, parse } from "date-fns";
import { tr } from "date-fns/locale";

import { istanbulDayKey } from "@/lib/istanbul-time";

/** Date-only strings ("yyyy-MM-dd") avoid timezone drift for @db.Date columns. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Date-only string -> Date at UTC midnight (what Postgres DATE stores). */
export function dateOnlyToDb(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** DB DATE (UTC midnight) -> "yyyy-MM-dd". */
export function dbToDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in the product's home timezone, as "yyyy-MM-dd". */
export function todayDateOnly(now: Date = new Date()): string {
  return istanbulDayKey(now);
}

/** "11 Kasım 2026" for a date-only string, without timezone shifts. */
export function formatDueDate(value: string, pattern = "d MMMM yyyy"): string {
  const d = parse(value, "yyyy-MM-dd", new Date());
  return isValid(d) ? format(d, pattern, { locale: tr }) : "";
}
