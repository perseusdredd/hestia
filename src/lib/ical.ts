import { addDaysToKey, istanbulDayKey } from "@/lib/istanbul-time";
import { isRecurrence } from "@/lib/recurrence";

/** Minimal RFC 5545 writer for the workspace calendar feed. Pure. */
export type IcalEvent = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  startsAt: Date;
  endsAt: Date;
  recurrence: string;
  recurrenceUntil: Date | null;
  updatedAt: Date;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** 20260310T070000Z */
export function icalUtc(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

const icalDate = (key: string) => key.replace(/-/g, "");

export function icalEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

/** Fold to 75 octets per line (continuation lines start with one space); never splits a UTF-8 sequence. */
export function icalFold(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > limit) {
      out.push(cur);
      cur = " ";
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out;
}

export function buildIcs(events: IcalEvent[], opts: { name: string; now?: Date; host?: string }): string {
  const now = opts.now ?? new Date();
  const host = opts.host ?? "hestia";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hestia//Calendar//TR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icalEscape(opts.name)}`,
    "X-WR-TIMEZONE:Europe/Istanbul",
  ];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.id}@${host}`, `DTSTAMP:${icalUtc(now)}`, `LAST-MODIFIED:${icalUtc(e.updatedAt)}`);
    let untilValue: string;
    if (e.allDay) {
      const startKey = istanbulDayKey(e.startsAt);
      const endKey = istanbulDayKey(e.endsAt);
      lines.push(`DTSTART;VALUE=DATE:${icalDate(startKey)}`, `DTEND;VALUE=DATE:${icalDate(addDaysToKey(endKey, 1))}`);
      untilValue = e.recurrenceUntil ? icalDate(istanbulDayKey(e.recurrenceUntil)) : "";
    } else {
      lines.push(`DTSTART:${icalUtc(e.startsAt)}`, `DTEND:${icalUtc(e.endsAt)}`);
      untilValue = e.recurrenceUntil ? icalUtc(e.recurrenceUntil) : "";
    }
    if (isRecurrence(e.recurrence) && e.recurrence !== "NONE") {
      lines.push(`RRULE:FREQ=${e.recurrence}${untilValue ? `;UNTIL=${untilValue}` : ""}`);
    }
    lines.push(`SUMMARY:${icalEscape(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${icalEscape(e.description)}`);
    if (e.location) lines.push(`LOCATION:${icalEscape(e.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.flatMap(icalFold).join("\r\n") + "\r\n";
}
