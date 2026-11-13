/**
 * Small sliding-window limiter for the auth, password and invite endpoints.
 *
 * LIMITATION (accepted for now, no dependency and no schema change): the
 * default store keeps its counters in this process's memory. On Vercel every
 * concurrent function instance is a separate process, instances are recycled
 * at any time, and cold starts begin empty. So:
 *  - the effective budget is `limit x number of warm instances`, not `limit`;
 *  - counters reset whenever an instance is recycled or a deploy goes out;
 *  - two requests from one attacker may land on different instances.
 * It still slows down a naive single-connection brute force, which is why it
 * stays on, but it is NOT a global limit. For a global one, implement
 * RateLimitStore over a shared store (Redis / Upstash, or a Postgres table
 * with an atomic upsert), register it with setRateLimitStore() at startup, and
 * move the callers from hitRateLimit() (sync, memory only) to the async
 * consumeRateLimit(), which goes through the registered store.
 */

/** A shared backend for the limiter. `hit` must record-and-check atomically. */
export interface RateLimitStore {
  /** Records one attempt for `key`; false when the key already used its budget (the rejected attempt is not recorded). */
  hit(key: string, rule: RateLimitRule, now: number): boolean | Promise<boolean>;
  reset?(): void | Promise<void>;
}

type Bucket = number[];

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 10_000;

export type RateLimitRule = { limit: number; windowMs: number };

/** Login: per normalized email and per client IP. Register: per client IP. */
export const AUTH_LIMITS = {
  loginPerEmail: { limit: 10, windowMs: 15 * 60_000 },
  loginPerIp: { limit: 50, windowMs: 15 * 60_000 },
  registerPerIp: { limit: 10, windowMs: 60 * 60_000 },
  /** Per normalized email: the per-IP budget can be dodged with a forged X-Forwarded-For. */
  registerPerEmail: { limit: 5, windowMs: 60 * 60_000 },
  /** Current-password checks on /account, per user. */
  passwordChangePerUser: { limit: 10, windowMs: 15 * 60_000 },
} satisfies Record<string, RateLimitRule>;

/**
 * Records one attempt for `key` and returns false when the key already used
 * its budget inside the window (the rejected attempt is not recorded).
 */
export function hitRateLimit(key: string, rule: RateLimitRule, now: number = Date.now()): boolean {
  const since = now - rule.windowMs;
  const bucket = (buckets.get(key) ?? []).filter((t) => t > since);
  if (bucket.length >= rule.limit) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.push(now);
  buckets.delete(key); // re-insert so Map order approximates recency
  buckets.set(key, bucket);
  if (buckets.size > MAX_KEYS) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  return true;
}

/** The per-process store behind hitRateLimit(). */
export const memoryRateLimitStore: RateLimitStore = {
  hit: (key, rule, now) => hitRateLimit(key, rule, now),
  reset: () => buckets.clear(),
};

let store: RateLimitStore = memoryRateLimitStore;

/** Plug in a shared store (call once at startup); null restores the in-memory store. */
export function setRateLimitStore(next: RateLimitStore | null): void {
  store = next ?? memoryRateLimitStore;
}

/** Store-aware variant of hitRateLimit(): use this from new callers. */
export async function consumeRateLimit(key: string, rule: RateLimitRule, now: number = Date.now()): Promise<boolean> {
  return store.hit(key, rule, now);
}

/**
 * Invitations send mail with inviter-chosen text (workspace and display name),
 * so they are throttled per inviter and per (workspace, address).
 */
export const INVITE_LIMITS = {
  invitePerUser: { limit: 20, windowMs: 60 * 60_000 },
  invitePerWorkspaceEmail: { limit: 3, windowMs: 60 * 60_000 },
} satisfies Record<string, RateLimitRule>;

/** Records one invite attempt; false when the inviter or the address is over budget. */
export function hitInviteRateLimit(
  actor: { userId: string; workspaceId: string },
  email: string,
  now: number = Date.now(),
): boolean {
  if (!hitRateLimit(`invite:user:${actor.userId}`, INVITE_LIMITS.invitePerUser, now)) return false;
  const normalized = email.trim().toLowerCase();
  return hitRateLimit(
    `invite:email:${actor.workspaceId}:${normalized}`,
    INVITE_LIMITS.invitePerWorkspaceEmail,
    now,
  );
}

/** Test helper. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * Best-effort client IP. x-forwarded-for is only trustworthy behind a proxy
 * that overwrites it (Vercel does); the per-email limit does not depend on it.
 */
export function clientIp(headers: Headers | null | undefined): string {
  const xff = headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || headers?.get("x-real-ip")?.trim() || "unknown";
}
