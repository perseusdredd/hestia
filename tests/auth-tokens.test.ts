import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  AUTH_TOKEN_TTL_MS,
  consumeAuthToken,
  createSessionReissueProof,
  hashAuthToken,
  INVALID_TOKEN_MESSAGE,
  issueAuthToken,
  SESSION_REISSUE_TTL_MS,
  verifySessionReissueProof,
} from "@/server/auth-tokens";
import { ServiceError } from "@/server/errors";

import { cleanup, createTestUser } from "./helpers";

afterAll(async () => {
  await cleanup();
});

async function expectInvalid(p: Promise<unknown>) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ServiceError);
  expect((e as ServiceError).code).toBe("VALIDATION");
  // Unknown, expired, used and wrong-type tokens are indistinguishable.
  expect((e as ServiceError).message).toBe(INVALID_TOKEN_MESSAGE);
}

describe("issueAuthToken", () => {
  it("stores only the SHA-256 hash with a 24 h (verify) / 1 h (reset) expiry", async () => {
    const user = await createTestUser();
    const now = new Date();
    const verify = await issueAuthToken(user.id, "EMAIL_VERIFY", { now });
    const reset = await issueAuthToken(user.id, "PASSWORD_RESET", { now });

    expect(verify.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(verify.token).not.toBe(reset.token);
    const rows = await db.authToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect([verify.token, reset.token]).not.toContain(row.tokenHash);

    const verifyRow = rows.find((r) => r.type === "EMAIL_VERIFY")!;
    const resetRow = rows.find((r) => r.type === "PASSWORD_RESET")!;
    expect(verifyRow.tokenHash).toBe(hashAuthToken(verify.token));
    expect(verifyRow.expiresAt.getTime() - now.getTime()).toBe(24 * 60 * 60_000);
    expect(resetRow.expiresAt.getTime() - now.getTime()).toBe(60 * 60_000);
    expect(AUTH_TOKEN_TTL_MS.PASSWORD_RESET).toBe(60 * 60_000);
  });

  it("invalidates the user's earlier unused tokens of the same type only", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const first = await issueAuthToken(user.id, "PASSWORD_RESET");
    const verify = await issueAuthToken(user.id, "EMAIL_VERIFY");
    const othersReset = await issueAuthToken(other.id, "PASSWORD_RESET");
    const second = await issueAuthToken(user.id, "PASSWORD_RESET");

    await expectInvalid(consumeAuthToken("PASSWORD_RESET", first.token));
    expect(await consumeAuthToken("PASSWORD_RESET", second.token)).toEqual({ userId: user.id });
    // Another type and another user's token are untouched.
    expect(await consumeAuthToken("EMAIL_VERIFY", verify.token)).toEqual({ userId: user.id });
    expect(await consumeAuthToken("PASSWORD_RESET", othersReset.token)).toEqual({ userId: other.id });
  });
});

describe("consumeAuthToken", () => {
  it("is single use", async () => {
    const user = await createTestUser();
    const { token } = await issueAuthToken(user.id, "EMAIL_VERIFY");
    expect(await consumeAuthToken("EMAIL_VERIFY", token)).toEqual({ userId: user.id });
    await expectInvalid(consumeAuthToken("EMAIL_VERIFY", token));
    const row = await db.authToken.findUnique({ where: { tokenHash: hashAuthToken(token) } });
    expect(row?.usedAt).toBeInstanceOf(Date);
  });

  it("lets exactly one of two parallel redemptions win", async () => {
    const user = await createTestUser();
    const { token } = await issueAuthToken(user.id, "PASSWORD_RESET");
    const results = await Promise.allSettled([
      consumeAuthToken("PASSWORD_RESET", token),
      consumeAuthToken("PASSWORD_RESET", token),
      consumeAuthToken("PASSWORD_RESET", token),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect((r.reason as ServiceError).message).toBe(INVALID_TOKEN_MESSAGE);
  });

  it("rejects an expired token", async () => {
    const user = await createTestUser();
    const issuedAt = new Date(Date.now() - AUTH_TOKEN_TTL_MS.PASSWORD_RESET - 1000);
    const { token } = await issueAuthToken(user.id, "PASSWORD_RESET", { now: issuedAt });
    await expectInvalid(consumeAuthToken("PASSWORD_RESET", token));
    // Still valid just before its expiry when evaluated at that time.
    const fresh = await issueAuthToken(user.id, "EMAIL_VERIFY", { now: issuedAt });
    await expectInvalid(
      consumeAuthToken("EMAIL_VERIFY", fresh.token, {
        now: new Date(issuedAt.getTime() + AUTH_TOKEN_TTL_MS.EMAIL_VERIFY + 1),
      }),
    );
    expect(
      await consumeAuthToken("EMAIL_VERIFY", fresh.token, {
        now: new Date(issuedAt.getTime() + AUTH_TOKEN_TTL_MS.EMAIL_VERIFY - 1000),
      }),
    ).toEqual({ userId: user.id });
  });

  it("gives the same error for unknown, malformed and wrong-type tokens", async () => {
    const user = await createTestUser();
    const { token } = await issueAuthToken(user.id, "EMAIL_VERIFY");
    await expectInvalid(consumeAuthToken("PASSWORD_RESET", token));
    await expectInvalid(consumeAuthToken("EMAIL_VERIFY", "A".repeat(43)));
    await expectInvalid(consumeAuthToken("EMAIL_VERIFY", "kısa"));
    await expectInvalid(consumeAuthToken("EMAIL_VERIFY", `${token}' OR 1=1 --`));
    await expectInvalid(consumeAuthToken("EMAIL_VERIFY", 12345));
    await expectInvalid(consumeAuthToken("EMAIL_VERIFY", undefined));
    // The wrong-type attempt did not burn it.
    expect(await consumeAuthToken("EMAIL_VERIFY", token)).toEqual({ userId: user.id });
  });

  it("does not burn the token when the caller's transaction rolls back", async () => {
    const user = await createTestUser();
    const { token } = await issueAuthToken(user.id, "PASSWORD_RESET");
    await expect(
      db.$transaction(async (tx) => {
        await consumeAuthToken("PASSWORD_RESET", token, { client: tx });
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    expect(await consumeAuthToken("PASSWORD_RESET", token)).toEqual({ userId: user.id });
  });
});

describe("session re-issue proof (password change keeps the current session)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("verifies only for the same user, version and within its TTL", () => {
    vi.stubEnv("AUTH_SECRET", "test-secret-for-reissue-proof");
    const now = 1_700_000_000_000;
    const proof = createSessionReissueProof("user-a", 3, now);
    expect(verifySessionReissueProof("user-a", proof, now)).toBe(3);
    expect(verifySessionReissueProof("user-b", proof, now)).toBeNull();
    expect(verifySessionReissueProof("user-a", proof, now + SESSION_REISSUE_TTL_MS + 1)).toBeNull();

    // Tampering with the version (or anything else) breaks the MAC.
    const [, expires, mac] = proof.split(".");
    expect(verifySessionReissueProof("user-a", `4.${expires}.${mac}`, now)).toBeNull();
    expect(verifySessionReissueProof("user-a", "garbage", now)).toBeNull();
    expect(verifySessionReissueProof("user-a", undefined, now)).toBeNull();
    expect(verifySessionReissueProof("user-a", { sessionReissue: proof }, now)).toBeNull();
  });

  it("is bound to AUTH_SECRET", () => {
    vi.stubEnv("AUTH_SECRET", "secret-one");
    const now = Date.now();
    const proof = createSessionReissueProof("user-a", 1, now);
    vi.stubEnv("AUTH_SECRET", "secret-two");
    expect(verifySessionReissueProof("user-a", proof, now)).toBeNull();
  });
});
