import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A pending upload has no DB row (the schema only stores finished files), so
 * its parameters travel in an HMAC-signed token. The server issues it after
 * validating name/size/type/folder; the local PUT route and completeUpload()
 * only trust what is inside a valid, unexpired token.
 */
export type UploadTokenPayload = {
  /** storage key (server generated) */
  k: string;
  /** workspace id */
  w: string;
  /** uploader user id */
  u: string;
  /** target folder id or null (root) */
  f: string | null;
  /** display name */
  n: string;
  /** declared size in bytes */
  s: number;
  /** normalised MIME type */
  t: string;
  /** expiry, ms since epoch */
  e: number;
  /** true for a chat photo: the File is hidden from the Files browser */
  c?: boolean;
  /** id of an existing File this upload is a NEW VERSION of (completeVersionUpload) */
  v?: string;
};

/** Short on purpose: a token is not marked as used, so it stays replayable until it expires. */
export const UPLOAD_TOKEN_TTL_MS = 10 * 60 * 1000;

const DEV_FALLBACK_SECRET = "hestia-dev-upload-secret-do-not-use-in-production";

function secret(): string {
  const s = process.env.UPLOAD_TOKEN_SECRET || process.env.AUTH_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET (or UPLOAD_TOKEN_SECRET) must be set");
  }
  return DEV_FALLBACK_SECRET;
}

function sign(data: string): string {
  return createHmac("sha256", `upload:${secret()}`).update(data).digest("base64url");
}

export function signUploadToken(payload: UploadTokenPayload): string {
  const data = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${data}.${sign(data)}`;
}

/** Returns the payload when the signature is valid and not expired, else null. */
export function verifyUploadToken(token: unknown, now = Date.now()): UploadTokenPayload | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const data = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(data), "base64url");
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as UploadTokenPayload;
    if (
      typeof p.k !== "string" ||
      typeof p.w !== "string" ||
      typeof p.u !== "string" ||
      (p.f !== null && typeof p.f !== "string") ||
      typeof p.n !== "string" ||
      typeof p.s !== "number" ||
      typeof p.t !== "string" ||
      typeof p.e !== "number" ||
      (p.c !== undefined && typeof p.c !== "boolean") ||
      (p.v !== undefined && typeof p.v !== "string")
    ) {
      return null;
    }
    if (p.e < now) return null;
    return p;
  } catch {
    return null;
  }
}
