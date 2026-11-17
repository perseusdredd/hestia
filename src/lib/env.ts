import { z } from "zod";

/**
 * Server environment validation.
 *
 * Nothing runs at import: `next build` imports server modules while it has no
 * secrets, so the check happens on first use of getServerEnv() at runtime.
 * validate() is pure (takes the env object) so it can be unit-tested.
 * Messages are developer-facing English and always name the variable.
 */

type RawEnv = Record<string, string | undefined>;

/** Blank strings count as unset (.env.example ships every key as ""). */
const optional = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().optional());

const shape = z.object({
  NODE_ENV: optional,
  VERCEL: optional,
  VERCEL_PROJECT_PRODUCTION_URL: optional,
  DATABASE_URL: optional,
  DIRECT_URL: optional,
  AUTH_SECRET: optional,
  AUTH_URL: optional,
  AUTH_GOOGLE_ID: optional,
  AUTH_GOOGLE_SECRET: optional,
  STORAGE_DRIVER: optional,
  ALLOW_LOCAL_STORAGE: optional,
  R2_ACCOUNT_ID: optional,
  R2_ACCESS_KEY_ID: optional,
  R2_SECRET_ACCESS_KEY: optional,
  R2_BUCKET: optional,
  BLOB_READ_WRITE_TOKEN: optional,
  BLOB_STORE_ID: optional,
  UPLOAD_TOKEN_SECRET: optional,
  PUSHER_APP_ID: optional,
  PUSHER_SECRET: optional,
  NEXT_PUBLIC_PUSHER_KEY: optional,
  NEXT_PUBLIC_PUSHER_CLUSTER: optional,
  MAIL_DRIVER: optional,
  SMTP_HOST: optional,
  SMTP_PORT: optional,
  SMTP_USER: optional,
  SMTP_PASS: optional,
  MAIL_FROM: optional,
  ENABLE_DEV_OUTBOX: optional,
  CRON_SECRET: optional,
  ANTHROPIC_API_KEY: optional,
  CLAUDE_MODEL: optional,
  HESTIA_SSO_SECRET: optional,
});

export type ServerEnv = z.infer<typeof shape> & {
  isProduction: boolean;
  storageDriver: "local" | "r2" | "blob";
  mailDriver: "outbox" | "smtp";
};

export type EnvValidation = { ok: true; env: ServerEnv } | { ok: false; errors: string[] };

export const MIN_AUTH_SECRET_LENGTH = 32;
export const MIN_CRON_SECRET_LENGTH = 16;

const R2_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;
const PUSHER_KEYS = ["PUSHER_APP_ID", "PUSHER_SECRET", "NEXT_PUBLIC_PUSHER_KEY"] as const;
const GOOGLE_KEYS = ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"] as const;

function isPostgresUrl(value: string): boolean {
  return /^postgres(ql)?:\/\/[^\s]+$/.test(value);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** All-or-none group check; returns one message naming the missing variables. */
function partialGroup(env: Record<string, string | undefined>, keys: readonly string[], group: string): string | null {
  const set = keys.filter((k) => env[k]);
  if (set.length === 0 || set.length === keys.length) return null;
  const missing = keys.filter((k) => !env[k]);
  return `${group} is partially configured: set ${missing.join(", ")} as well (or clear ${set.join(", ")}).`;
}

export function validate(input: RawEnv): EnvValidation {
  const env = shape.parse(input);
  const errors: string[] = [];
  const isProduction = env.NODE_ENV === "production";

  // --- Database
  if (!env.DATABASE_URL) errors.push("DATABASE_URL is required (postgresql://...).");
  else if (!isPostgresUrl(env.DATABASE_URL)) errors.push("DATABASE_URL must be a postgres:// or postgresql:// URL.");
  if (env.DIRECT_URL && !isPostgresUrl(env.DIRECT_URL)) {
    errors.push("DIRECT_URL must be a postgres:// or postgresql:// URL.");
  }
  if (isProduction && !env.DIRECT_URL) {
    errors.push("DIRECT_URL is required in production (prisma/schema.prisma uses it for migrations; use the non-pooled Neon URL).");
  }

  // --- Auth
  if (!env.AUTH_SECRET) errors.push("AUTH_SECRET is required (generate one with `npx auth secret`).");
  else if (env.AUTH_SECRET.length < MIN_AUTH_SECRET_LENGTH) {
    errors.push(`AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters (generate one with \`npx auth secret\`).`);
  }
  if (env.AUTH_URL) {
    const url = parseUrl(env.AUTH_URL);
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      errors.push("AUTH_URL must be an absolute http(s) URL, e.g. https://app.example.com.");
    } else if (isProduction && url.protocol !== "https:" && !isLocalHost(url)) {
      errors.push("AUTH_URL must use https in production (emailed links are built from it).");
    }
  } else if (isProduction && !env.VERCEL_PROJECT_PRODUCTION_URL) {
    errors.push("AUTH_URL is required in production (emailed verify/reset/invite links are built from it).");
  }
  const google = partialGroup(env, GOOGLE_KEYS, "Google sign-in");
  if (google) errors.push(google);

  // --- Storage
  const driverRaw = (env.STORAGE_DRIVER ?? "local").toLowerCase();
  let storageDriver: ServerEnv["storageDriver"] = "local";
  if (driverRaw === "r2" || driverRaw === "local" || driverRaw === "blob") storageDriver = driverRaw;
  else errors.push(`STORAGE_DRIVER must be "local", "r2" or "blob" (got "${env.STORAGE_DRIVER}").`);
  const r2 = partialGroup(env, R2_KEYS, "R2 storage");
  if (r2) errors.push(r2);
  if (storageDriver === "r2") {
    const missing = R2_KEYS.filter((k) => !env[k]);
    if (missing.length && !r2) errors.push(`STORAGE_DRIVER="r2" requires ${missing.join(", ")}.`);
    if (env.R2_ACCOUNT_ID && !/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID)) {
      errors.push("R2_ACCOUNT_ID must be the 32-character hex Cloudflare account id.");
    }
    if (env.R2_BUCKET && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET)) {
      errors.push("R2_BUCKET must be a lowercase bucket name (letters, digits, hyphens).");
    }
  }
  if (storageDriver === "blob" && !env.BLOB_READ_WRITE_TOKEN && !env.BLOB_STORE_ID) {
    errors.push('STORAGE_DRIVER="blob" requires BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID with Vercel OIDC).');
  }
  if (storageDriver === "local" && isProduction && env.ALLOW_LOCAL_STORAGE !== "true") {
    errors.push('STORAGE_DRIVER="local" is not allowed in production (the filesystem is not persistent on Vercel); use "r2" or "blob", or set ALLOW_LOCAL_STORAGE="true" for a local production build.');
  }
  if (env.UPLOAD_TOKEN_SECRET && env.UPLOAD_TOKEN_SECRET.length < MIN_AUTH_SECRET_LENGTH) {
    errors.push(`UPLOAD_TOKEN_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters when set.`);
  }

  // --- Realtime
  const pusher = partialGroup(env, PUSHER_KEYS, "Pusher realtime");
  if (pusher) errors.push(pusher);
  if (env.NEXT_PUBLIC_PUSHER_CLUSTER && !/^[a-z0-9-]{1,32}$/.test(env.NEXT_PUBLIC_PUSHER_CLUSTER)) {
    errors.push('NEXT_PUBLIC_PUSHER_CLUSTER must be a cluster id such as "eu" or "us2".');
  }

  // --- Mail
  const mailRaw = (env.MAIL_DRIVER ?? "outbox").toLowerCase();
  let mailDriver: ServerEnv["mailDriver"] = "outbox";
  if (mailRaw === "outbox" || mailRaw === "smtp") mailDriver = mailRaw;
  else errors.push(`MAIL_DRIVER must be "outbox" or "smtp" (got "${env.MAIL_DRIVER}").`);
  if (mailDriver === "smtp") {
    if (!env.SMTP_HOST) errors.push('MAIL_DRIVER="smtp" requires SMTP_HOST.');
    if (!env.MAIL_FROM) errors.push('MAIL_DRIVER="smtp" requires MAIL_FROM, e.g. "Hestia <no-reply@example.com>".');
    if (env.SMTP_PORT && !/^\d{1,5}$/.test(env.SMTP_PORT)) errors.push("SMTP_PORT must be a port number (587 or 465).");
    const auth = partialGroup(env, ["SMTP_USER", "SMTP_PASS"], "SMTP authentication");
    if (auth) errors.push(auth);
  }
  if (env.VERCEL && env.ENABLE_DEV_OUTBOX === "true") {
    errors.push('ENABLE_DEV_OUTBOX="true" must not be set on a Vercel deployment (it exposes mailed links in the app).');
  }

  // --- Cron
  if (env.CRON_SECRET && env.CRON_SECRET.length < MIN_CRON_SECRET_LENGTH) {
    errors.push(`CRON_SECRET must be at least ${MIN_CRON_SECRET_LENGTH} characters when set.`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, env: { ...env, isProduction, storageDriver, mailDriver } };
}

export class EnvValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`Invalid server environment:\n- ${errors.join("\n- ")}`);
    this.name = "EnvValidationError";
  }
}

let cached: ServerEnv | null = null;

/** Validated server env, checked once per process on first call. Throws EnvValidationError. */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const result = validate(process.env);
  if (!result.ok) throw new EnvValidationError(result.errors);
  cached = result.env;
  return cached;
}

/** Tests only. */
export function resetServerEnvCache(): void {
  cached = null;
}
