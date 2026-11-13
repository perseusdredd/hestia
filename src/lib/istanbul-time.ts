import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  startOfMonth,
  startOfWeek,
} from "date-fns";

/**
 * Europe/Istanbul is a fixed UTC+3 offset (no DST since 2016). All wall-time
 * conversions are explicit so nothing depends on the server's TZ.
 * Pure module: safe to import from client components.
 */
export const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

export type IstanbulParts = { year: number; month: number; day: number; hour: number; minute: number };

/** Parse "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" as Istanbul wall time. Returns null when invalid. */
export function parseIstanbulLocal(value: string): Date | null {
  const m = LOCAL_RE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi));
  // Reject overflowing values such as 2026-02-31 or 25:00.
  if (
    wall.getUTCFullYear() !== y ||
    wall.getUTCMonth() !== mo - 1 ||
    wall.getUTCDate() !== d ||
    wall.getUTCHours() !== h ||
    wall.getUTCMinutes() !== mi
  ) {
    return null;
  }
  return new Date(wall.getTime() - ISTANBUL_OFFSET_MS);
}

/** Istanbul wall-clock components of an instant. */
export function toIstanbulParts(date: Date): IstanbulParts {
  const s = new Date(date.getTime() + ISTANBUL_OFFSET_MS);
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth() + 1,
    day: s.getUTCDate(),
    hour: s.getUTCHours(),
    minute: s.getUTCMinutes(),
  };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of the Istanbul calendar day containing `date`. */
export function istanbulDayKey(date: Date): string {
  const p = toIstanbulParts(date);
  return `${p.year}-${p2(p.month)}-${p2(p.day)}`;
}

/** "HH:mm" Istanbul wall time. */
export function istanbulTime(date: Date): string {
  const p = toIstanbulParts(date);
  return `${p2(p.hour)}:${p2(p.minute)}`;
}

/** Value for <input type="datetime-local"> (or type="date" when !withTime). */
export function toIstanbulInputValue(date: Date, withTime: boolean): string {
  return withTime ? `${istanbulDayKey(date)}T${istanbulTime(date)}` : istanbulDayKey(date);
}

/** Instant of 00:00:00.000 Istanbul on `dayKey`. */
export function istanbulDayStart(dayKey: string): Date {
  const d = parseIstanbulLocal(dayKey);
  if (!d) throw new Error(`Invalid day key: ${dayKey}`);
  return d;
}

/** Instant of 23:59:59.999 Istanbul on `dayKey`. */
export function istanbulDayEnd(dayKey: string): Date {
  return new Date(istanbulDayStart(dayKey).getTime() + DAY_MS - 1);
}

export function isMonthParam(value: string | undefined | null): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Calendar-only Date (local midnight) for a day key; use for date-fns calendar math and formatting. */
export function keyToCalendarDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function calendarDateToKey(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

/** Add `n` days to a day key (pure calendar arithmetic). */
export function addDaysToKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}

export function shiftMonth(month: string, delta: number): string {
  return format(addMonths(keyToCalendarDate(`${month}-01`), delta), "yyyy-MM");
}

export type MonthGrid = { month: string; days: string[]; firstKey: string; lastKey: string };

/** Mon-first grid of day keys covering the month (4-6 full weeks). */
export function buildMonthGrid(month: string): MonthGrid {
  const first = startOfMonth(keyToCalendarDate(`${month}-01`));
  const days = eachDayOfInterval({
    start: startOfWeek(first, { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(first), { weekStartsOn: 1 }),
  }).map(calendarDateToKey);
  return { month, days, firstKey: days[0], lastKey: days[days.length - 1] };
}

/**
 * Day keys an event covers. A timed event ending exactly at 00:00 does not
 * spill onto the next day. Capped to avoid runaway loops.
 */
export function eventDayKeys(startsAt: Date, endsAt: Date): string[] {
  const startKey = istanbulDayKey(startsAt);
  let endKey = istanbulDayKey(endsAt);
  if (endsAt.getTime() > startsAt.getTime() && istanbulTime(endsAt) === "00:00" && endKey > startKey) {
    endKey = addDaysToKey(endKey, -1);
  }
  const keys: string[] = [];
  for (let k = startKey; k <= endKey && keys.length < 400; k = addDaysToKey(k, 1)) keys.push(k);
  return keys;
}
