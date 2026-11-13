import { format, formatDistanceToNow, isValid } from "date-fns";
import { tr } from "date-fns/locale";

import { toIstanbulParts } from "@/lib/istanbul-time";

type DateInput = Date | string | number;

function toDate(d: DateInput): Date {
  return d instanceof Date ? d : new Date(d);
}

/**
 * A Date whose LOCAL fields equal the Istanbul wall time of `date`, so
 * date-fns `format` prints Istanbul time whatever TZ the process runs in
 * (UTC on Vercel, the viewer's zone in the browser). Server and client
 * output therefore match, which also keeps hydration consistent.
 */
function istanbulWallClock(date: Date): Date {
  const p = toIstanbulParts(date);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, date.getUTCSeconds(), date.getUTCMilliseconds());
}

/** "11 Kasım 2026" in Europe/Istanbul (pattern overridable, Turkish locale). */
export function formatDate(d: DateInput, pattern = "d MMMM yyyy"): string {
  const date = toDate(d);
  return isValid(date) ? format(istanbulWallClock(date), pattern, { locale: tr }) : "";
}

/** "11 Kasım 2026 14:30" (Europe/Istanbul) */
export function formatDateTime(d: DateInput): string {
  return formatDate(d, "d MMMM yyyy HH:mm");
}

/** "3 gün önce" / "5 dakika önce" */
export function formatRelative(d: DateInput): string {
  const date = toDate(d);
  return isValid(date) ? formatDistanceToNow(date, { addSuffix: true, locale: tr }) : "";
}
