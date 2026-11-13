import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { AuthTokenType, Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { ServiceError } from "@/server/errors";

/*
 * Single-use, mailed account tokens (email verification, password reset).
 * Documented exception to the ctx-first rule: these belong to a user, not a
 * workspace. Only the SHA-256 hash is stored; the raw token lives in the link.
 * Lookups go by hash (a unique index), so no raw-token comparison happens and
 * the lookup time does not depend on how many leading characters match.
 */

type Client = Prisma.TransactionClient | typeof db;

export const AUTH_TOKEN_TTL_MS: Record<AuthTokenType, number> = {
  EMAIL_VERIFY: 24 * 60 * 60_000,
  PASSWORD_RESET: 60 * 60_000,
};

/** Same message for unknown, expired and already-used tokens. */
export const INVALID_TOKEN_MESSAGE = "Bağlantı geçersiz veya süresi dolmuş. Lütfen yeni bir bağlantı isteyin.";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export function hashAuthToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Issue a new token of `type` for `userId` and return the raw token (once).
 * Any earlier unused token of the same type for that user stops working.
 */
export async function issueAuthToken(
  userId: string,
  type: AuthTokenType,
  opts: { client?: Client; now?: Date } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const now = opts.now ?? new Date();
  const token = generateAuthToken();
  const expiresAt = new Date(now.getTime() + AUTH_TOKEN_TTL_MS[type]);
  const run = async (tx: Client) => {
    // Invalidate by expiring: usedAt keeps meaning "was redeemed".
    await tx.authToken.updateMany({
      where: { userId, type, usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    await tx.authToken.create({ data: { userId, type, tokenHash: hashAuthToken(token), expiresAt } });
  };
  if (opts.client) await run(opts.client);
  else await db.$transaction(run);
  return { token, expiresAt };
}

/**
 * Redeem a token. Atomic single use: the conditional update only matches an
 * unused, unexpired token of the right type, so of two parallel calls exactly
 * one wins. Pass `client` (a transaction) to make the redemption part of the
 * caller's write, so a failing write does not burn the token.
 */
export async function consumeAuthToken(
  type: AuthTokenType,
  rawToken: unknown,
  opts: { client?: Client; now?: Date } = {},
): Promise<{ userId: string }> {
  const client = opts.client ?? db;
  const now = opts.now ?? new Date();
  if (typeof rawToken !== "string" || !TOKEN_PATTERN.test(rawToken)) throw invalidToken();
  const tokenHash = hashAuthToken(rawToken);

  const claimed = await client.authToken.updateMany({
    where: { tokenHash, type, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) throw invalidToken();

  const row = await client.authToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  if (!row) throw invalidToken();
  return { userId: row.userId };
}

function invalidToken() {
  return new ServiceError("VALIDATION", INVALID_TOKEN_MESSAGE);
}

// ------------------------------------------- session re-issue proof ----
/*
 * After a password change the signed-in user's own JWT must be re-issued with
 * the new sessionVersion (every other session stays revoked). The re-issue
 * goes through Auth.js' session update (jwt callback, trigger "update"), which
 * a client can also trigger with its own payload. So the payload is an HMAC
 * proof only the server can mint: it binds the user id and the new version to
 * a short expiry and is keyed by AUTH_SECRET. A stolen, revoked cookie cannot
 * upgrade itself without it.
 */

export const SESSION_REISSUE_TTL_MS = 60_000;

function reissueSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set.");
  return secret;
}

function reissueMac(userId: string, version: number, expires: number): string {
  return createHmac("sha256", reissueSecret())
    .update(`session-reissue:${userId}:${version}:${expires}`, "utf8")
    .digest("base64url");
}

/** Server-minted proof that `userId` may carry `version` in a fresh JWT. */
export function createSessionReissueProof(userId: string, version: number, now = Date.now()): string {
  const expires = now + SESSION_REISSUE_TTL_MS;
  return `${version}.${expires}.${reissueMac(userId, version, expires)}`;
}

/** Returns the proven version, or null for anything forged, foreign or stale. */
export function verifySessionReissueProof(
  userId: string,
  proof: unknown,
  now = Date.now(),
): number | null {
  if (typeof proof !== "string" || proof.length > 200) return null;
  const match = /^(\d{1,9})\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(proof);
  if (!match) return null;
  const version = Number(match[1]);
  const expires = Number(match[2]);
  if (expires <= now || expires > now + SESSION_REISSUE_TTL_MS) return null;
  const expected = Buffer.from(reissueMac(userId, version, expires), "utf8");
  const given = Buffer.from(match[3], "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return version;
}
