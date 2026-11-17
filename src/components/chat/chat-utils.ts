/**
 * Pure helpers for the chat UI (no React, no DOM) - unit-tested in
 * tests/chat.test.ts.
 */
import { format, isSameDay, subDays } from "date-fns";
import { tr } from "date-fns/locale";

import {
  compareCursor,
  decodeCursor,
  encodeCursor,
  type ChatAuthor,
  type ChatMessageDTO,
  type ChatMessagesResponse,
} from "@/lib/pusher/chat-protocol";

// ------------------------------------------------------------- merging ----

/** Merge `incoming` into `current` (both ascending), dedupe by id, keep order. */
export function mergeMessages(
  current: ChatMessageDTO[],
  incoming: ChatMessageDTO[],
  skipIds?: ReadonlySet<string>,
): ChatMessageDTO[] {
  const fresh = incoming.filter((m) => !skipIds?.has(m.id));
  if (fresh.length === 0) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  let changed = false;
  for (const m of fresh) {
    if (!byId.has(m.id)) changed = true;
    byId.set(m.id, m);
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => compareCursor(a.cursor, b.cursor));
}

/**
 * Polling deletion sync. `liveIds` is every id with cursor in [from, ...] at
 * query time; only messages in [from, upTo] are judged so messages that
 * arrived after the poll was sent are never dropped by a stale response.
 */
export function dropDeleted(
  current: ChatMessageDTO[],
  liveIds: readonly string[],
  from: string,
  upTo: string,
): ChatMessageDTO[] {
  const live = new Set(liveIds);
  const next = current.filter(
    (m) => live.has(m.id) || compareCursor(m.cursor, from) < 0 || compareCursor(m.cursor, upTo) > 0,
  );
  return next.length === current.length ? current : next;
}

// ------------------------------------------------------------- syncing ----

/**
 * Re-read window for sync(). Rows can land in the table "behind" a cursor the
 * client already holds (another user's insert committing late, ids that are
 * not monotonic across processes), so every sync re-asks for this much time
 * before the newest message the SERVER has returned. mergeMessages dedupes.
 */
export const SYNC_OVERLAP_MS = 15_000;

/**
 * The `after` cursor for the next sync. `serverCursor` is the newest cursor a
 * sync response returned (never one learned from the sender's own action or
 * a realtime event). Null = nothing synced yet: ask for the newest page.
 */
export function syncAfterCursor(serverCursor: string | null, overlapMs: number = SYNC_OVERLAP_MS): string | null {
  const c = serverCursor ? decodeCursor(serverCursor) : null;
  if (!c) return null;
  // "<ms>_0" sorts before every real id (cuids start with a letter).
  return encodeCursor(new Date(Math.max(0, c.createdAt.getTime() - overlapMs)), "0");
}

/** Newest of two cursors (either may be null). */
export function maxCursor(a: string | null, b: string | null | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return compareCursor(a, b) >= 0 ? a : b;
}

export type AfterPageFetch = (after: string) => Promise<ChatMessagesResponse | null>;

/**
 * Pages forward from `after` while the server reports `hasMoreAfter`, so a
 * reconnect after a long gap fetches everything instead of the first page.
 * Returns null on a failed request; `truncated` when `maxPages` was hit.
 */
export async function collectAfter(
  first: ChatMessagesResponse,
  fetchPage: AfterPageFetch,
  maxPages = 20,
): Promise<{ messages: ChatMessageDTO[]; truncated: boolean } | null> {
  const messages = [...first.messages];
  let more = Boolean(first.hasMoreAfter);
  let pages = 1;
  while (more && messages.length > 0) {
    if (pages >= maxPages) return { messages, truncated: true };
    const next = await fetchPage(messages[messages.length - 1].cursor);
    if (!next) return null;
    messages.push(...next.messages);
    more = Boolean(next.hasMoreAfter);
    pages++;
  }
  return { messages, truncated: false };
}

// ------------------------------------------------------------ grouping ----

export type FeedItem = {
  key: string;
  /** Server id; null while the message is still being sent. */
  id: string | null;
  body: string;
  /** Photo attached to a sent message. */
  image?: { id: string; name: string };
  createdAt: Date;
  author: ChatAuthor;
  status: "sent" | "sending" | "failed";
  error?: string;
  clientId?: string;
};

export type FeedRow =
  | { type: "day"; key: string; label: string }
  | { type: "group"; key: string; author: ChatAuthor; items: FeedItem[] };

/** Consecutive messages from one author within this window share a header. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function dayLabel(d: Date, now: Date = new Date()): string {
  if (isSameDay(d, now)) return "Bugün";
  if (isSameDay(d, subDays(now, 1))) return "Dün";
  const sameYear = d.getFullYear() === now.getFullYear();
  return format(d, sameYear ? "d MMMM, EEEE" : "d MMMM yyyy, EEEE", { locale: tr });
}

export function timeLabel(d: Date): string {
  return format(d, "HH:mm", { locale: tr });
}

/** Builds day separators + author groups from ascending items. */
export function groupFeed(items: FeedItem[], now: Date = new Date()): FeedRow[] {
  const rows: FeedRow[] = [];
  let group: Extract<FeedRow, { type: "group" }> | null = null;
  let prev: FeedItem | null = null;
  for (const item of items) {
    const newDay = !prev || !isSameDay(prev.createdAt, item.createdAt);
    if (newDay) {
      rows.push({ type: "day", key: `day-${item.key}`, label: dayLabel(item.createdAt, now) });
      group = null;
    }
    const continues =
      group !== null &&
      prev !== null &&
      prev.author.id === item.author.id &&
      item.createdAt.getTime() - prev.createdAt.getTime() < GROUP_WINDOW_MS;
    if (continues && group) {
      group.items.push(item);
    } else {
      group = { type: "group", key: `group-${item.key}`, author: item.author, items: [item] };
      rows.push(group);
    }
    prev = item;
  }
  return rows;
}
