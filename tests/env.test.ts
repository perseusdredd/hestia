import { describe, expect, it } from "vitest";

import { validate } from "@/lib/env";

const SECRET = "x".repeat(44);
const DEV = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://hestia:hestia@127.0.0.1:5433/hestia?schema=public",
  AUTH_SECRET: SECRET,
};
const PROD = {
  ...DEV,
  NODE_ENV: "production",
  DIRECT_URL: "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db?sslmode=require",
  AUTH_URL: "https://app.example.com",
  STORAGE_DRIVER: "r2",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "hestia-files",
};

function errorsOf(env: Record<string, string | undefined>): string[] {
  const r = validate(env);
  return r.ok ? [] : r.errors;
}

describe("validate(env)", () => {
  it("accepts a minimal development env and a complete production env", () => {
    expect(validate(DEV).ok).toBe(true);
    const prod = validate(PROD);
    expect(prod.ok).toBe(true);
    if (prod.ok) expect(prod.env.storageDriver).toBe("r2");
  });

  it("treats blank strings as unset (the .env.example style)", () => {
    const r = validate({ ...DEV, AUTH_GOOGLE_ID: "", AUTH_GOOGLE_SECRET: "", R2_BUCKET: "  ", PUSHER_APP_ID: "" });
    expect(r.ok).toBe(true);
  });

  it("requires DATABASE_URL and a long enough AUTH_SECRET", () => {
    expect(errorsOf({ ...DEV, DATABASE_URL: undefined }).join()).toMatch(/DATABASE_URL is required/);
    expect(errorsOf({ ...DEV, DATABASE_URL: "mysql://x" }).join()).toMatch(/DATABASE_URL must be/);
    expect(errorsOf({ ...DEV, AUTH_SECRET: undefined }).join()).toMatch(/AUTH_SECRET is required/);
    expect(errorsOf({ ...DEV, AUTH_SECRET: "short" }).join()).toMatch(/AUTH_SECRET must be at least 32/);
  });

  it("requires AUTH_URL (https) and DIRECT_URL in production", () => {
    expect(errorsOf({ ...PROD, AUTH_URL: undefined }).join()).toMatch(/AUTH_URL is required in production/);
    expect(validate({ ...PROD, AUTH_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: "app.vercel.app" }).ok).toBe(true);
    expect(errorsOf({ ...PROD, AUTH_URL: "http://app.example.com" }).join()).toMatch(/AUTH_URL must use https/);
    expect(validate({ ...PROD, AUTH_URL: "http://localhost:3230" }).ok).toBe(true);
    expect(errorsOf({ ...PROD, AUTH_URL: "not a url" }).join()).toMatch(/AUTH_URL must be an absolute/);
    expect(errorsOf({ ...PROD, DIRECT_URL: undefined }).join()).toMatch(/DIRECT_URL is required in production/);
    expect(validate({ ...DEV, AUTH_URL: undefined }).ok).toBe(true);
  });

  it("rejects local storage in production unless explicitly allowed", () => {
    const local = { ...PROD, STORAGE_DRIVER: "local", R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_BUCKET: "" };
    expect(errorsOf(local).join()).toMatch(/STORAGE_DRIVER="local" is not allowed in production/);
    expect(validate({ ...local, ALLOW_LOCAL_STORAGE: "true" }).ok).toBe(true);
    expect(validate({ ...DEV, STORAGE_DRIVER: "local" }).ok).toBe(true);
    expect(errorsOf({ ...DEV, STORAGE_DRIVER: "s3" }).join()).toMatch(/STORAGE_DRIVER must be/);
  });

  it("R2_* is all-or-none and validated when the r2 driver is selected", () => {
    expect(errorsOf({ ...PROD, R2_BUCKET: undefined }).join()).toMatch(/R2 storage is partially configured: set R2_BUCKET/);
    expect(errorsOf({ ...DEV, R2_ACCOUNT_ID: "abc" }).join()).toMatch(/R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET/);
    expect(errorsOf({ ...PROD, R2_ACCOUNT_ID: "nothex" }).join()).toMatch(/R2_ACCOUNT_ID must be/);
    const noR2 = { ...DEV, STORAGE_DRIVER: "r2" };
    expect(errorsOf(noR2).join()).toMatch(/STORAGE_DRIVER="r2" requires R2_ACCOUNT_ID/);
  });

  it("PUSHER_* is all-or-none and the cluster must be a plain id", () => {
    expect(errorsOf({ ...DEV, PUSHER_APP_ID: "1" }).join()).toMatch(/Pusher realtime is partially configured: set PUSHER_SECRET, NEXT_PUBLIC_PUSHER_KEY/);
    expect(validate({ ...DEV, PUSHER_APP_ID: "1", PUSHER_SECRET: "s", NEXT_PUBLIC_PUSHER_KEY: "k", NEXT_PUBLIC_PUSHER_CLUSTER: "eu" }).ok).toBe(true);
    expect(errorsOf({ ...DEV, NEXT_PUBLIC_PUSHER_CLUSTER: "eu; x" }).join()).toMatch(/NEXT_PUBLIC_PUSHER_CLUSTER/);
  });

  it("MAIL_DRIVER=smtp needs SMTP_HOST, MAIL_FROM and paired credentials", () => {
    const smtp = { ...DEV, MAIL_DRIVER: "smtp" };
    const errs = errorsOf(smtp).join();
    expect(errs).toMatch(/requires SMTP_HOST/);
    expect(errs).toMatch(/requires MAIL_FROM/);
    expect(errorsOf({ ...smtp, SMTP_HOST: "smtp.x", MAIL_FROM: "H <a@b.c>", SMTP_USER: "u" }).join()).toMatch(/SMTP authentication is partially configured: set SMTP_PASS/);
    expect(validate({ ...smtp, SMTP_HOST: "smtp.x", MAIL_FROM: "H <a@b.c>", SMTP_PORT: "465" }).ok).toBe(true);
    expect(errorsOf({ ...DEV, MAIL_DRIVER: "sendgrid" }).join()).toMatch(/MAIL_DRIVER must be/);
    // The outbox driver ignores SMTP settings.
    expect(validate({ ...DEV, SMTP_HOST: "smtp.x" }).ok).toBe(true);
  });

  it("Google id and secret come as a pair", () => {
    expect(errorsOf({ ...DEV, AUTH_GOOGLE_ID: "id" }).join()).toMatch(/Google sign-in is partially configured: set AUTH_GOOGLE_SECRET/);
    expect(validate({ ...DEV, AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "s" }).ok).toBe(true);
  });

  it("checks optional secrets and Vercel-only rules", () => {
    expect(errorsOf({ ...DEV, CRON_SECRET: "short" }).join()).toMatch(/CRON_SECRET must be at least 16/);
    expect(errorsOf({ ...DEV, UPLOAD_TOKEN_SECRET: "short" }).join()).toMatch(/UPLOAD_TOKEN_SECRET/);
    expect(errorsOf({ ...PROD, VERCEL: "1", ENABLE_DEV_OUTBOX: "true" }).join()).toMatch(/ENABLE_DEV_OUTBOX/);
  });

  it("reports every problem at once, naming each variable", () => {
    const errs = errorsOf({ NODE_ENV: "production" });
    expect(errs.length).toBeGreaterThanOrEqual(4);
    for (const name of ["DATABASE_URL", "AUTH_SECRET", "AUTH_URL", "STORAGE_DRIVER"]) {
      expect(errs.some((e) => e.includes(name))).toBe(true);
    }
  });
});
