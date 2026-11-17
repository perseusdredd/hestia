/**
 * Wire format of the chat module, shared by the service layer, the route
 * handlers, the realtime events and the browser. Pure module.
 */

export const CHAT_PAGE_SIZE = 50;
export const CHAT_MAX_BODY = 4000;

/** Photos in chat: types the browser can preview safely, and the size cap. */
export const CHAT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"] as const;
export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export type ChatAuthor = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

export type ChatImage = { id: string; name: string; size: number };

export type ChatMessageDTO = {
  id: string;
  body: string;
  /** Optional photo (served by /api/files/<id>/inline). */
  image?: ChatImage;
  /** ISO timestamp (millisecond precision, same as the DB column). */
  createdAt: string;
  authorId: string;
  author: ChatAuthor;
  /** Opaque, stable pagination cursor: "<epoch ms>_<id>". */
  cursor: string;
  /** The browser send id; present only on the viewer's own messages. */
  clientId?: string;
};

/**
 * Realtime "new message" event. Only a reference, never the content: Pusher
 * subscriptions are authorised once, so a member removed while subscribed
 * would otherwise keep reading messages. Clients fetch the body over the
 * membership-checked HTTP route.
 */
export type ChatMessageEvent = { kind: "ref"; id: string; cursor: string; clientId?: string };

export type ChatDeleteEvent = { id: string };

/** Response of GET /api/chat/[slug]/messages. */
export type ChatMessagesResponse = {
  /** Ascending (oldest first). */
  messages: ChatMessageDTO[];
  /** Only for ?before= and the initial page: true when older messages exist. */
  hasMore?: boolean;
  /** Only for ?after=: true when more newer messages exist past this page. */
  hasMoreAfter?: boolean;
  /**
   * Only for ?after=&from=: ids of every message with cursor >= from (newest
   * first, capped). Lets polling clients drop messages deleted elsewhere.
   * `liveIdsComplete` is false when the cap was hit.
   */
  liveIds?: string[];
  liveIdsComplete?: boolean;
};

const CURSOR_PATTERN = /^(\d{1,15})_([a-z0-9]{1,64})$/;

export type ChatCursor = { createdAt: Date; id: string };

export function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.getTime()}_${id}`;
}

/** Returns null for malformed input (never throws). */
export function decodeCursor(raw: unknown): ChatCursor | null {
  if (typeof raw !== "string") return null;
  const m = CURSOR_PATTERN.exec(raw);
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isSafeInteger(ms)) return null;
  const createdAt = new Date(ms);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: m[2] };
}

/** Total order used everywhere: createdAt, then id. Negative when a < b. */
export function compareCursor(a: string, b: string): number {
  const ca = decodeCursor(a);
  const cb = decodeCursor(b);
  if (!ca || !cb) return a < b ? -1 : a > b ? 1 : 0;
  const dt = ca.createdAt.getTime() - cb.createdAt.getTime();
  if (dt !== 0) return dt;
  return ca.id < cb.id ? -1 : ca.id > cb.id ? 1 : 0;
}
