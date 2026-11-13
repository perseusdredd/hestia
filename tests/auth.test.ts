import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it } from "vitest";

import { BCRYPT_MAX_BYTES, newPasswordField } from "@/lib/auth-schemas";
import { ACCOUNT_MAIL_LIMITS } from "@/server/account";
import {
  AUTH_LIMITS,
  clientIp,
  hitInviteRateLimit,
  hitRateLimit,
  INVITE_LIMITS,
  resetRateLimits,
} from "@/server/rate-limit";

describe("new password validation (bcrypt 72-byte truncation regression)", () => {
  it("rejects passwords whose UTF-8 form exceeds 72 bytes, even under 200 chars", () => {
    const turkish = "ş".repeat(36) + "secret"; // 78 bytes, 42 chars
    expect(Buffer.byteLength(turkish, "utf8")).toBeGreaterThan(BCRYPT_MAX_BYTES);
    expect(newPasswordField.safeParse(turkish).success).toBe(false);
    expect(newPasswordField.safeParse("a".repeat(73)).success).toBe(false);
  });

  it("accepts passwords up to exactly 72 bytes", () => {
    expect(newPasswordField.safeParse("a".repeat(72)).success).toBe(true);
    expect(newPasswordField.safeParse("ş".repeat(36)).success).toBe(true);
    expect(newPasswordField.safeParse("kısa").success).toBe(false);
  });

  it("documents why: bcrypt ignores everything past 72 bytes", () => {
    const hash = bcrypt.hashSync("ş".repeat(36) + "secret", 4);
    expect(bcrypt.compareSync("ş".repeat(36) + "XXXX", hash)).toBe(true);
  });
});

describe("auth rate limiter", () => {
  afterEach(() => resetRateLimits());

  it("blocks a key after `limit` attempts within the window, then recovers", () => {
    const rule = AUTH_LIMITS.loginPerEmail;
    const t0 = 1_000_000;
    for (let i = 0; i < rule.limit; i++) expect(hitRateLimit("login:email:a@x.test", rule, t0 + i)).toBe(true);
    expect(hitRateLimit("login:email:a@x.test", rule, t0 + rule.limit)).toBe(false);
    // Other keys are independent.
    expect(hitRateLimit("login:email:b@x.test", rule, t0)).toBe(true);
    // After the window the budget is back.
    expect(hitRateLimit("login:email:a@x.test", rule, t0 + rule.windowMs + rule.limit + 1)).toBe(true);
  });

  it("reads the first x-forwarded-for hop, then x-real-ip", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    expect(clientIp(undefined)).toBe("unknown");
  });
});

describe("mailed-flow rate limits", () => {
  afterEach(() => resetRateLimits());

  it("forgot-password allows a few requests per email per hour, then blocks", () => {
    const rule = ACCOUNT_MAIL_LIMITS.forgotPasswordPerEmail;
    expect(rule.windowMs).toBe(60 * 60_000);
    const t0 = 5_000_000;
    for (let i = 0; i < rule.limit; i++) {
      expect(hitRateLimit("forgot:email:a@x.test", rule, t0 + i)).toBe(true);
    }
    expect(hitRateLimit("forgot:email:a@x.test", rule, t0 + rule.limit)).toBe(false);
    expect(ACCOUNT_MAIL_LIMITS.forgotPasswordPerIp.limit).toBeGreaterThan(rule.limit);
  });

  it("verification resend is limited per user", () => {
    const rule = ACCOUNT_MAIL_LIMITS.verifyResendPerUser;
    for (let i = 0; i < rule.limit; i++) expect(hitRateLimit("verify-resend:user:u1", rule, i)).toBe(true);
    expect(hitRateLimit("verify-resend:user:u1", rule, rule.limit)).toBe(false);
    expect(hitRateLimit("verify-resend:user:u2", rule, rule.limit)).toBe(true);
  });
});

describe("invitation mail rate limits", () => {
  afterEach(() => resetRateLimits());
  const actor = { userId: "u1", workspaceId: "w1" };

  it("limits re-inviting the same address in a workspace (case/space-insensitive)", () => {
    const rule = INVITE_LIMITS.invitePerWorkspaceEmail;
    const t0 = 7_000_000;
    for (let i = 0; i < rule.limit; i++) {
      expect(hitInviteRateLimit(actor, i % 2 ? " Kurban@X.test " : "kurban@x.test", t0 + i)).toBe(true);
    }
    expect(hitInviteRateLimit(actor, "KURBAN@x.test", t0 + rule.limit)).toBe(false);
    // Another workspace (same inviter) has its own per-address budget.
    expect(hitInviteRateLimit({ userId: "u1", workspaceId: "w2" }, "kurban@x.test", t0)).toBe(true);
    // After the window it recovers.
    expect(hitInviteRateLimit(actor, "kurban@x.test", t0 + rule.windowMs + rule.limit + 1)).toBe(true);
  });

  it("limits the total invites one user sends, across workspaces and addresses", () => {
    const rule = INVITE_LIMITS.invitePerUser;
    const t0 = 9_000_000;
    for (let i = 0; i < rule.limit; i++) {
      expect(hitInviteRateLimit({ userId: "u9", workspaceId: `w${i}` }, `a${i}@x.test`, t0 + i)).toBe(true);
    }
    expect(hitInviteRateLimit({ userId: "u9", workspaceId: "wz" }, "yeni@x.test", t0 + rule.limit)).toBe(false);
    expect(hitInviteRateLimit({ userId: "u10", workspaceId: "wz" }, "yeni@x.test", t0)).toBe(true);
  });

  it("registration is also limited per email", () => {
    const rule = AUTH_LIMITS.registerPerEmail;
    for (let i = 0; i < rule.limit; i++) expect(hitRateLimit("register:email:a@x.test", rule, i)).toBe(true);
    expect(hitRateLimit("register:email:a@x.test", rule, rule.limit)).toBe(false);
  });
});
