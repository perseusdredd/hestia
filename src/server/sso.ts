import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

import { db } from "@/lib/db";

/**
 * Single sign-on from the Perseus assistant app.
 *
 * Perseus mints a short-lived token "<base64url(json)>.<hmac-sha256 hex>"
 * signed with the shared HESTIA_SSO_SECRET. /sso verifies it and signs the
 * matching Hestia user in (creating it on first use). Without the secret the
 * whole feature is off.
 */
const MAX_TOKEN_AGE_SEC = 90;
const usedTokens = new Map<string, number>(); // jti -> exp (seconds)

type SsoPayload = { email: string; name?: string; exp: number; jti: string };

function secret(): string | null {
  const s = process.env.HESTIA_SSO_SECRET?.trim();
  return s && s.length >= 32 ? s : null;
}

function sign(body: string, key: string): Buffer {
  return createHmac("sha256", key).update(body).digest();
}

export function parseSsoToken(token: string, now = Date.now() / 1000): SsoPayload | null {
  const key = secret();
  if (!key || token.length > 2000) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const given = Buffer.from(sig, "hex");
  const expected = sign(body, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: SsoPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.email !== "string" || typeof payload.jti !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp < now || payload.exp > now + MAX_TOKEN_AGE_SEC) return null;
  return payload;
}

/** Verifies the token, rejects replays, and returns the (created if needed) user. */
export async function consumeSsoToken(token: string) {
  const payload = parseSsoToken(token);
  if (!payload) return null;
  const now = Date.now() / 1000;
  for (const [jti, exp] of usedTokens) if (exp < now) usedTokens.delete(jti);
  if (usedTokens.has(payload.jti)) return null;
  usedTokens.set(payload.jti, payload.exp);

  const email = payload.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const name = payload.name?.trim().slice(0, 80) || email.split("@")[0];
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return existing.emailVerified
      ? existing
      : db.user.update({ where: { id: existing.id }, data: { emailVerified: new Date() } });
  }
  return db.user.create({ data: { email, name, emailVerified: new Date() } });
}
