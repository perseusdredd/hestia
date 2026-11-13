import bcrypt from "bcryptjs";
import { afterAll, describe, expect, it } from "vitest";

import { BCRYPT_MAX_BYTES } from "@/lib/auth-schemas";
import { db } from "@/lib/db";
import {
  changePassword,
  FORGOT_PASSWORD_MESSAGE,
  getAccount,
  requestPasswordReset,
  resetPasswordWithToken,
  sendVerificationEmail,
  updateProfile,
  verifyEmailWithToken,
} from "@/server/account";
import { INVALID_TOKEN_MESSAGE, issueAuthToken } from "@/server/auth-tokens";
import { ServiceError } from "@/server/errors";
import { leaveWorkspace, listUserWorkspaces } from "@/server/workspaces";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

afterAll(async () => {
  await cleanup();
});

async function expectServiceError(p: Promise<unknown>, code: ServiceError["code"]) {
  await expect(p).rejects.toBeInstanceOf(ServiceError);
  await p.catch((e: ServiceError) => expect(e.code).toBe(code));
}

async function userWithPassword(password = "eski-sifre-1") {
  return createTestUser({ passwordHash: await bcrypt.hash(password, 4) });
}

describe("getAccount", () => {
  it("returns own profile and never the hash", async () => {
    const user = await userWithPassword();
    const account = await getAccount(user.id);
    expect(account).toMatchObject({ id: user.id, email: user.email, hasPassword: true });
    expect(account).not.toHaveProperty("passwordHash");
  });

  it("reports hasPassword=false for Google-only users", async () => {
    const user = await createTestUser();
    expect((await getAccount(user.id)).hasPassword).toBe(false);
  });

  it("unknown user is NOT_FOUND", async () => {
    await expectServiceError(getAccount("nope"), "NOT_FOUND");
  });
});

describe("updateProfile", () => {
  it("changes the display name (trimmed)", async () => {
    const user = await createTestUser();
    await updateProfile(user.id, { name: "  Ayşe Çelik  " });
    expect((await db.user.findUnique({ where: { id: user.id } }))?.name).toBe("Ayşe Çelik");
  });

  it("validates the name", async () => {
    const user = await createTestUser({ name: "Kalıcı Ad" });
    await expectServiceError(updateProfile(user.id, { name: "A" }), "VALIDATION");
    await expectServiceError(updateProfile(user.id, { name: "   " }), "VALIDATION");
    await expectServiceError(updateProfile(user.id, { name: "x".repeat(81) }), "VALIDATION");
    await expectServiceError(updateProfile(user.id, {}), "VALIDATION");
    await expectServiceError(updateProfile(user.id, { name: 42 }), "VALIDATION");
    expect((await db.user.findUnique({ where: { id: user.id } }))?.name).toBe("Kalıcı Ad");
  });

  it("cannot change another user via id, userId, email or passwordHash parameters", async () => {
    const me = await createTestUser({ name: "Ben" });
    const other = await createTestUser({ name: "Başkası" });
    await updateProfile(me.id, {
      name: "Yeni Ad",
      id: other.id,
      userId: other.id,
      email: "hacked@hestia.test",
      passwordHash: "x",
    });
    const otherAfter = await db.user.findUnique({ where: { id: other.id } });
    const meAfter = await db.user.findUnique({ where: { id: me.id } });
    expect(otherAfter?.name).toBe("Başkası");
    expect(otherAfter?.email).toBe(other.email);
    expect(meAfter?.name).toBe("Yeni Ad");
    expect(meAfter?.email).toBe(me.email);
    expect(meAfter?.passwordHash).toBeNull();
  });

  it("unknown user id is NOT_FOUND", async () => {
    await expectServiceError(updateProfile("nope", { name: "Geçerli Ad" }), "NOT_FOUND");
  });
});

describe("changePassword", () => {
  it("rejects a wrong current password and keeps the old one", async () => {
    const user = await userWithPassword("eski-sifre-1");
    await expectServiceError(
      changePassword(user.id, { currentPassword: "yanlis-sifre", newPassword: "yeni-sifre-22" }),
      "VALIDATION",
    );
    const row = await db.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare("eski-sifre-1", row!.passwordHash!)).toBe(true);
  });

  it("requires the current password when one is set", async () => {
    const user = await userWithPassword();
    await expectServiceError(changePassword(user.id, { newPassword: "yeni-sifre-22" }), "VALIDATION");
    await expectServiceError(
      changePassword(user.id, { currentPassword: "", newPassword: "yeni-sifre-22" }),
      "VALIDATION",
    );
  });

  it("changes the password: old fails, new verifies", async () => {
    const user = await userWithPassword("eski-sifre-1");
    await changePassword(user.id, { currentPassword: "eski-sifre-1", newPassword: "yeni-sifre-22" });
    const row = await db.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare("eski-sifre-1", row!.passwordHash!)).toBe(false);
    expect(await bcrypt.compare("yeni-sifre-22", row!.passwordHash!)).toBe(true);
  });

  it("enforces the registration password rules, including the 72-byte limit", async () => {
    const user = await userWithPassword("eski-sifre-1");
    const current = "eski-sifre-1";
    await expectServiceError(
      changePassword(user.id, { currentPassword: current, newPassword: "kisa" }),
      "VALIDATION",
    );
    // 40 x "ş" = 80 bytes (2 bytes each) but only 40 characters.
    const tooManyBytes = "ş".repeat(40);
    expect(Buffer.byteLength(tooManyBytes)).toBeGreaterThan(BCRYPT_MAX_BYTES);
    await expectServiceError(
      changePassword(user.id, { currentPassword: current, newPassword: tooManyBytes }),
      "VALIDATION",
    );
    await expectServiceError(
      changePassword(user.id, { currentPassword: current, newPassword: current }),
      "VALIDATION",
    );
    const row = await db.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare(current, row!.passwordHash!)).toBe(true);
  });

  it("lets a user without a password set one without a current password", async () => {
    const user = await createTestUser();
    await changePassword(user.id, { newPassword: "ilk-sifrem-1" });
    const row = await db.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare("ilk-sifrem-1", row!.passwordHash!)).toBe(true);
  });

  it("only touches the given user row", async () => {
    const me = await userWithPassword("eski-sifre-1");
    const other = await userWithPassword("baskasi-sifre-1");
    const otherBefore = (await db.user.findUnique({ where: { id: other.id } }))!.passwordHash;
    await changePassword(me.id, {
      currentPassword: "eski-sifre-1",
      newPassword: "yeni-sifre-22",
      userId: other.id,
      id: other.id,
    });
    expect((await db.user.findUnique({ where: { id: other.id } }))!.passwordHash).toBe(otherBefore);
    // The other user's current password does not unlock my row.
    await expectServiceError(
      changePassword(me.id, { currentPassword: "baskasi-sifre-1", newPassword: "bir-baska-sifre" }),
      "VALIDATION",
    );
  });

  it("unknown user is NOT_FOUND", async () => {
    await expectServiceError(changePassword("nope", { newPassword: "yeni-sifre-22" }), "NOT_FOUND");
  });
});

describe("account workspace list and leave", () => {
  it("lists only the user's own workspaces with roles", async () => {
    const owner = await createTestUser();
    const { workspace: mine } = await createTestWorkspace(owner.id);
    const { workspace: foreign } = await createTestWorkspace((await createTestUser()).id);
    const list = await listUserWorkspaces(owner.id);
    expect(list.map((w) => w.id)).toContain(mine.id);
    expect(list.map((w) => w.id)).not.toContain(foreign.id);
    expect(list.find((w) => w.id === mine.id)?.role).toBe("OWNER");
  });

  it("a member can leave; the last owner cannot", async () => {
    const owner = await createTestUser();
    const { workspace, ctx: ownerCtx } = await createTestWorkspace(owner.id);
    const { user, ctx } = await createMember(workspace.id, "MEMBER");
    await leaveWorkspace(ctx);
    expect(await db.membership.count({ where: { userId: user.id, workspaceId: workspace.id } })).toBe(0);
    await expectServiceError(leaveWorkspace(ownerCtx), "CONFLICT");
  });
});

describe("changePassword session revocation", () => {
  it("bumps sessionVersion (revokes other sessions) and returns the new value", async () => {
    const user = await userWithPassword("eski-sifre-1");
    expect(user.sessionVersion).toBe(0);
    const result = await changePassword(user.id, {
      currentPassword: "eski-sifre-1",
      newPassword: "yeni-sifre-22",
    });
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.sessionVersion).toBe(1);
    expect(result.sessionVersion).toBe(1);
    // A failed attempt does not bump it.
    await expectServiceError(
      changePassword(user.id, { currentPassword: "yanlis", newPassword: "baska-sifre-33" }),
      "VALIDATION",
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion).toBe(1);
  });
});

// ------------------------------------------------- mailed account flows ----

async function latestMail(to: string, kind: string) {
  return db.emailOutbox.findFirst({ where: { to, kind }, orderBy: { createdAt: "desc" } });
}

function tokenFrom(text: string | undefined, path: string): string {
  const match = new RegExp(`/${path}/([A-Za-z0-9_-]+)`).exec(text ?? "");
  if (!match) throw new Error(`no ${path} link in mail`);
  return match[1];
}

async function resetToken(email: string) {
  return tokenFrom((await latestMail(email, "password-reset"))?.text, "reset-password");
}

const mailedTo = new Set<string>();
afterAll(async () => {
  await db.emailOutbox.deleteMany({ where: { to: { in: [...mailedTo] } } });
});

describe("requestPasswordReset", () => {
  it("writes an outbox row for an existing user and none for an unknown email, same result", async () => {
    const user = await userWithPassword();
    mailedTo.add(user.email);
    const unknown = `yok-${Date.now()}@hestia.test`;
    mailedTo.add(unknown);

    const known = await requestPasswordReset({ email: `  ${user.email.toUpperCase()} ` });
    const missing = await requestPasswordReset({ email: unknown });
    expect(known.ok).toBe(true);
    expect(missing.ok).toBe(true);
    expect(known.message).toBe(FORGOT_PASSWORD_MESSAGE);
    expect(missing.message).toBe(known.message);
    expect(Object.keys(missing).sort()).toEqual(Object.keys(known).sort());

    const mail = await latestMail(user.email, "password-reset");
    expect(mail?.text).toMatch(/\/reset-password\/[A-Za-z0-9_-]{43}/);
    expect(await db.emailOutbox.count({ where: { to: unknown } })).toBe(0);
    expect(await db.authToken.count({ where: { userId: user.id, type: "PASSWORD_RESET" } })).toBe(1);
  });

  it("validates the email format", async () => {
    await expectServiceError(requestPasswordReset({ email: "değil" }), "VALIDATION");
  });
});

describe("resetPasswordWithToken", () => {
  it("sets the new password, bumps sessionVersion and is single use", async () => {
    const user = await userWithPassword("eski-sifre-1");
    mailedTo.add(user.email);
    await requestPasswordReset({ email: user.email });
    const token = await resetToken(user.email);

    await resetPasswordWithToken({ token, password: "yeni-sifre-22" });
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare("yeni-sifre-22", row.passwordHash!)).toBe(true);
    expect(await bcrypt.compare("eski-sifre-1", row.passwordHash!)).toBe(false);
    expect(row.sessionVersion).toBe(user.sessionVersion + 1);
    // The link proved control of the inbox.
    expect(row.emailVerified).toBeInstanceOf(Date);

    await expect(resetPasswordWithToken({ token, password: "ucuncu-sifre-3" })).rejects.toThrow(
      INVALID_TOKEN_MESSAGE,
    );
  });

  it("an earlier reset link stops working once a newer one is requested", async () => {
    const user = await userWithPassword();
    mailedTo.add(user.email);
    await requestPasswordReset({ email: user.email });
    const first = await resetToken(user.email);
    await requestPasswordReset({ email: user.email });
    const second = await resetToken(user.email);
    expect(second).not.toBe(first);
    await expect(resetPasswordWithToken({ token: first, password: "yeni-sifre-22" })).rejects.toThrow(
      INVALID_TOKEN_MESSAGE,
    );
    await resetPasswordWithToken({ token: second, password: "yeni-sifre-22" });
  });

  it("applies the registration rules (72 bytes) without burning the token", async () => {
    const user = await userWithPassword("eski-sifre-1");
    mailedTo.add(user.email);
    await requestPasswordReset({ email: user.email });
    const token = await resetToken(user.email);
    await expectServiceError(resetPasswordWithToken({ token, password: "kisa" }), "VALIDATION");
    await expectServiceError(resetPasswordWithToken({ token, password: "ş".repeat(40) }), "VALIDATION");
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.sessionVersion).toBe(0);
    await resetPasswordWithToken({ token, password: "gecerli-sifre-1" });
  });

  it("lets a Google-only user (no passwordHash) set a password", async () => {
    const user = await createTestUser();
    mailedTo.add(user.email);
    await requestPasswordReset({ email: user.email });
    await resetPasswordWithToken({ token: await resetToken(user.email), password: "ilk-sifrem-1" });
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare("ilk-sifrem-1", row.passwordHash!)).toBe(true);
  });

  it("rejects unknown and expired tokens with the same message", async () => {
    await expect(
      resetPasswordWithToken({ token: "A".repeat(43), password: "yeni-sifre-22" }),
    ).rejects.toThrow(INVALID_TOKEN_MESSAGE);
    const user = await userWithPassword();
    mailedTo.add(user.email);
    await requestPasswordReset({ email: user.email });
    const token = await resetToken(user.email);
    await db.authToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(resetPasswordWithToken({ token, password: "yeni-sifre-22" })).rejects.toThrow(
      INVALID_TOKEN_MESSAGE,
    );
  });
});

describe("changePassword expires outstanding reset links", () => {
  it("a reset link issued before a password change no longer works; verify links still do", async () => {
    const user = await userWithPassword("eski-sifre-1");
    const { token: reset } = await issueAuthToken(user.id, "PASSWORD_RESET");
    const { token: verify } = await issueAuthToken(user.id, "EMAIL_VERIFY");
    await changePassword(user.id, { currentPassword: "eski-sifre-1", newPassword: "yeni-sifre-22" });
    await expect(resetPasswordWithToken({ token: reset, password: "saldirgan-33" })).rejects.toThrow(
      INVALID_TOKEN_MESSAGE,
    );
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare("yeni-sifre-22", row.passwordHash!)).toBe(true);
    expect(await verifyEmailWithToken(verify)).toEqual({ userId: user.id });
  });

  it("a failed change (wrong current password) leaves the reset link usable", async () => {
    const user = await userWithPassword("eski-sifre-1");
    const { token } = await issueAuthToken(user.id, "PASSWORD_RESET");
    await expectServiceError(
      changePassword(user.id, { currentPassword: "yanlis", newPassword: "yeni-sifre-22" }),
      "VALIDATION",
    );
    await resetPasswordWithToken({ token, password: "gecerli-sifre-1" });
  });
});

describe("email verification", () => {
  it("mails a link that sets emailVerified once", async () => {
    const user = await createTestUser();
    mailedTo.add(user.email);
    const sent = await sendVerificationEmail(user.id);
    expect(sent.alreadyVerified).toBe(false);
    const token = tokenFrom((await latestMail(user.email, "verify-email"))?.text, "verify-email");

    expect(await verifyEmailWithToken(token)).toEqual({ userId: user.id });
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.emailVerified).toBeInstanceOf(Date);
    await expect(verifyEmailWithToken(token)).rejects.toThrow(INVALID_TOKEN_MESSAGE);

    // Already verified: nothing more is mailed.
    const before = await db.emailOutbox.count({ where: { to: user.email } });
    expect((await sendVerificationEmail(user.id)).alreadyVerified).toBe(true);
    expect(await db.emailOutbox.count({ where: { to: user.email } })).toBe(before);
  });

  it("a verify token cannot be used as a reset token", async () => {
    const user = await createTestUser();
    mailedTo.add(user.email);
    await sendVerificationEmail(user.id);
    const token = tokenFrom((await latestMail(user.email, "verify-email"))?.text, "verify-email");
    await expect(resetPasswordWithToken({ token, password: "yeni-sifre-22" })).rejects.toThrow(
      INVALID_TOKEN_MESSAGE,
    );
  });
});
