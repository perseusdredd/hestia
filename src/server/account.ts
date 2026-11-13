import bcrypt from "bcryptjs";
import { z } from "zod";

import { newPasswordField } from "@/lib/auth-schemas";
import { db } from "@/lib/db";
import { appLink, getAppOrigin } from "@/lib/mail/origin";
import { passwordResetMail, verifyEmailMail } from "@/lib/mail/templates";
import {
  consumeAuthToken,
  generateAuthToken,
  hashAuthToken,
  issueAuthToken,
} from "@/server/auth-tokens";
import { notFound, parseInput, ServiceError } from "@/server/errors";
import { queueMail, type MailStatus } from "@/server/mail";
import type { RateLimitRule } from "@/server/rate-limit";

/*
 * Account service. Documented exception to the ctx-first rule (like
 * createWorkspace): there is no workspace here, so every function takes the
 * signed-in `userId` (from the session, never from the client) as its first
 * argument and only ever reads or writes that user's row. Input objects are
 * parsed with zod, which strips unknown keys, so a smuggled `userId`/`id`/
 * `email` field in the input is ignored.
 */

const BCRYPT_ROUNDS = 10;

export const displayNameSchema = z
  .string({ error: "Ad gerekli." })
  .trim()
  .min(2, "Adınız en az 2 karakter olmalı.")
  .max(80, "Adınız en fazla 80 karakter olabilir.");

const profileSchema = z.object({ name: displayNameSchema });

const passwordSchema = z.object({
  currentPassword: z.string().max(200, "Şifre çok uzun.").optional(),
  newPassword: newPasswordField,
});

async function loadUser(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      passwordHash: true,
      emailVerified: true,
    },
  });
  if (!user) throw notFound("Hesap bulunamadı.");
  return user;
}

/** Profile data for /account. Never exposes the hash, only whether one is set. */
export async function getAccount(userId: string) {
  const user = await loadUser(userId);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    hasPassword: Boolean(user.passwordHash),
    emailVerified: Boolean(user.emailVerified),
  };
}

export async function updateProfile(userId: string, input: unknown) {
  const data = parseInput(profileSchema, input);
  const { count } = await db.user.updateMany({ where: { id: userId }, data: { name: data.name } });
  if (count === 0) throw notFound("Hesap bulunamadı.");
  return { name: data.name };
}

/**
 * Change the password. Users with a passwordHash must prove the current one;
 * users without (Google sign-up) may set a first password. Bumps
 * sessionVersion, which signs out every other session; the caller re-issues
 * the current session (see changePasswordAction).
 */
export async function changePassword(userId: string, input: unknown) {
  const data = parseInput(passwordSchema, input);
  const user = await loadUser(userId);

  if (user.passwordHash) {
    if (!data.currentPassword) {
      throw new ServiceError("VALIDATION", "Mevcut şifrenizi girin.", {
        currentPassword: ["Mevcut şifrenizi girin."],
      });
    }
    const ok = await bcrypt.compare(data.currentPassword, user.passwordHash);
    if (!ok) {
      throw new ServiceError("VALIDATION", "Mevcut şifre hatalı.", {
        currentPassword: ["Mevcut şifre hatalı."],
      });
    }
    if (data.currentPassword === data.newPassword) {
      throw new ServiceError("VALIDATION", "Yeni şifre mevcut şifreden farklı olmalı.", {
        newPassword: ["Yeni şifre mevcut şifreden farklı olmalı."],
      });
    }
  }

  const passwordHash = await bcrypt.hash(data.newPassword, BCRYPT_ROUNDS);
  const after = await db.$transaction(async (tx) => {
    const now = new Date();
    // Guard on the hash we verified so a concurrent change is not silently overwritten.
    const { count } = await tx.user.updateMany({
      where: { id: userId, passwordHash: user.passwordHash },
      data: { passwordHash, sessionVersion: { increment: 1 } },
    });
    if (count === 0) {
      throw new ServiceError("CONFLICT", "Şifre bu sırada değişti. Lütfen tekrar deneyin.");
    }
    // A reset link issued before this change must not outlive it.
    await tx.authToken.updateMany({
      where: { userId, type: "PASSWORD_RESET", usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    const row = await tx.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } });
    if (!row) throw notFound("Hesap bulunamadı.");
    return row;
  });
  return { ok: true as const, email: user.email, sessionVersion: after.sessionVersion };
}

// ------------------------------------------- mailed account flows ----
/*
 * Password reset and email verification. requestPasswordReset() takes an
 * email (the requester is anonymous); the rest take the token or the
 * signed-in userId. Each returns a `deliver` thunk: the server action runs it
 * with after() so SMTP latency never shows up in the response.
 */

/** Budgets for the mailed flows, enforced by the server actions with hitRateLimit(). */
export const ACCOUNT_MAIL_LIMITS = {
  forgotPasswordPerIp: { limit: 10, windowMs: 60 * 60_000 },
  forgotPasswordPerEmail: { limit: 3, windowMs: 60 * 60_000 },
  verifyResendPerUser: { limit: 3, windowMs: 60 * 60_000 },
} satisfies Record<string, RateLimitRule>;

export const FORGOT_PASSWORD_MESSAGE =
  "Bu e-posta adresiyle kayıtlı bir hesap varsa, şifre sıfırlama bağlantısını içeren bir e-posta gönderdik. Gelen kutunuzu ve istenmeyen klasörünü kontrol edin.";

const emailField = z
  .string({ error: "E-posta gerekli." })
  .trim()
  .toLowerCase()
  .max(254, "E-posta adresi çok uzun.")
  .pipe(z.email("Geçerli bir e-posta adresi girin."));

const forgotSchema = z.object({ email: emailField });
const resetSchema = z.object({
  token: z.string().max(200),
  password: newPasswordField,
});

type Deliver = () => Promise<MailStatus>;
const nothingToDeliver: Deliver = async () => "queued";

/**
 * Start a password reset. The result is identical whether or not the email
 * belongs to an account, and the same kind of work runs in both cases (token
 * generation + hashing, a user lookup, one transaction), so the response
 * neither says nor (much) times whether the address exists. Internal failures
 * are logged, never surfaced. Users without a passwordHash (Google-only) get a
 * link too: reset is how they can set a first password.
 */
export async function requestPasswordReset(
  input: unknown,
): Promise<{ ok: true; message: string; deliver: Deliver }> {
  const { email } = parseInput(forgotSchema, input);
  let deliver = nothingToDeliver;
  try {
    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true },
    });
    if (user) {
      const origin = getAppOrigin();
      const { token } = await issueAuthToken(user.id, "PASSWORD_RESET");
      const content = passwordResetMail({
        name: user.name,
        link: `${origin}/reset-password/${token}`,
      });
      const queued = await queueMail({ to: user.email, ...content, kind: "password-reset" });
      deliver = queued.deliver;
    } else {
      // Mirror the token work and the invalidate-transaction of the real path.
      hashAuthToken(generateAuthToken());
      await db.$transaction(async (tx) => {
        await tx.authToken.updateMany({
          where: { userId: "", type: "PASSWORD_RESET", usedAt: null },
          data: { expiresAt: new Date() },
        });
      });
    }
  } catch (e) {
    console.error("[account] password reset request failed:", e instanceof Error ? e.message : e);
  }
  return { ok: true, message: FORGOT_PASSWORD_MESSAGE, deliver };
}

/**
 * Finish a password reset: same password rules as registration (incl. the
 * 72-byte bcrypt limit). Redeems the token in the same transaction as the
 * password write, bumps sessionVersion (signs out every session), expires any
 * other reset link and, since the link proved control of the inbox, marks the
 * email verified.
 */
export async function resetPasswordWithToken(input: unknown): Promise<{ email: string }> {
  const data = parseInput(resetSchema, input);
  const passwordHash = await bcrypt.hash(data.password, BCRYPT_ROUNDS);
  return db.$transaction(async (tx) => {
    const now = new Date();
    const { userId } = await consumeAuthToken("PASSWORD_RESET", data.token, { client: tx, now });
    const user = await tx.user.update({
      where: { id: userId },
      data: { passwordHash, sessionVersion: { increment: 1 } },
      select: { email: true },
    });
    await tx.user.updateMany({
      where: { id: userId, emailVerified: null },
      data: { emailVerified: now },
    });
    await tx.authToken.updateMany({
      where: { userId, type: "PASSWORD_RESET", usedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    return { email: user.email };
  });
}

/** Mail a verification link to the user's address (no-op when already verified). */
export async function sendVerificationEmail(
  userId: string,
): Promise<{ alreadyVerified: boolean; deliver: Deliver }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, emailVerified: true },
  });
  if (!user) throw notFound("Hesap bulunamadı.");
  if (user.emailVerified) return { alreadyVerified: true, deliver: nothingToDeliver };
  // Resolves the origin first, so a missing AUTH_URL fails before a token is issued.
  const base = appLink("/verify-email/");
  const { token } = await issueAuthToken(user.id, "EMAIL_VERIFY");
  const content = verifyEmailMail({ name: user.name, link: `${base}${token}` });
  const queued = await queueMail({ to: user.email, ...content, kind: "verify-email" });
  return { alreadyVerified: false, deliver: queued.deliver };
}

/** Redeem a verification link: sets emailVerified (kept when already set). */
export async function verifyEmailWithToken(token: unknown): Promise<{ userId: string }> {
  return db.$transaction(async (tx) => {
    const now = new Date();
    const { userId } = await consumeAuthToken("EMAIL_VERIFY", token, { client: tx, now });
    await tx.user.updateMany({
      where: { id: userId, emailVerified: null },
      data: { emailVerified: now },
    });
    return { userId };
  });
}
