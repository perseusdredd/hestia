"use server";

import bcrypt from "bcryptjs";
import { AuthError, CredentialsSignin } from "next-auth";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { signIn, signOut } from "@/auth";
import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { newPasswordField } from "@/lib/auth-schemas";
import { db } from "@/lib/db";
import { safeCallbackUrl } from "@/lib/safe-redirect";
import { checkSession, SESSION_EXPIRED_PATH } from "@/lib/tenant";
import {
  ACCOUNT_MAIL_LIMITS,
  FORGOT_PASSWORD_MESSAGE,
  requestPasswordReset,
  resetPasswordWithToken,
  sendVerificationEmail,
  verifyEmailWithToken,
} from "@/server/account";
import { AUTH_LIMITS, clientIp, hitRateLimit } from "@/server/rate-limit";

const INVALID_CREDENTIALS = "E-posta veya şifre hatalı.";
const TOO_MANY_ATTEMPTS = "Çok fazla deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin.";

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Geçerli bir e-posta adresi girin."));

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Şifrenizi girin.").max(200),
});

const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Adınız en az 2 karakter olmalı.")
    .max(80, "Adınız en fazla 80 karakter olabilir."),
  email: emailField,
  password: newPasswordField,
});

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse({
    email: formString(formData, "email"),
    password: formString(formData, "password"),
  });
  const values = { email: formString(formData, "email") };
  if (!parsed.success) {
    return {
      ok: false,
      error: "Lütfen formdaki hataları düzeltin.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
      values,
    };
  }
  const redirectTo = safeCallbackUrl(formString(formData, "callbackUrl"));
  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo,
    });
  } catch (e) {
    if (e instanceof CredentialsSignin && e.code === "rate_limited") {
      return { ok: false, error: TOO_MANY_ATTEMPTS, values };
    }
    if (e instanceof AuthError) return { ok: false, error: INVALID_CREDENTIALS, values };
    throw e; // NEXT_REDIRECT on success
  }
  return { ok: true };
}

export async function registerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = registerSchema.safeParse({
    name: formString(formData, "name"),
    email: formString(formData, "email"),
    password: formString(formData, "password"),
  });
  const values = { name: formString(formData, "name"), email: formString(formData, "email") };
  if (!parsed.success) {
    return {
      ok: false,
      error: "Lütfen formdaki hataları düzeltin.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
      values,
    };
  }
  if (!hitRateLimit(`register:ip:${clientIp(await headers())}`, AUTH_LIMITS.registerPerIp)) {
    return { ok: false, error: TOO_MANY_ATTEMPTS, values };
  }
  const { name, email, password } = parsed.data;
  if (!hitRateLimit(`register:email:${email.trim().toLowerCase()}`, AUTH_LIMITS.registerPerEmail)) {
    return { ok: false, error: TOO_MANY_ATTEMPTS, values };
  }
  const redirectTo = safeCallbackUrl(formString(formData, "callbackUrl"));

  const passwordHash = await bcrypt.hash(password, 10);
  let userId: string;
  try {
    ({ id: userId } = await db.user.create({ data: { name, email, passwordHash }, select: { id: true } }));
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Accepted product decision: registration says the address is taken.
      // Hiding it would mean not signing new users in either (a mailed
      // "finish sign-up" step). The cost is account enumeration, bounded by
      // registerPerIp and registerPerEmail above; it reveals no account data.
      return {
        ok: false,
        error: "Bu e-posta adresiyle kayıt oluşturulamadı. Hesabınız varsa giriş yapın.",
        fieldErrors: { email: ["Bu e-posta adresi kullanılamıyor."] },
        values,
      };
    }
    throw e;
  }

  // Verification mail: never blocks or fails the registration.
  await queueVerificationMail(userId);

  try {
    await signIn("credentials", { email, password, redirectTo });
  } catch (e) {
    if (e instanceof AuthError) {
      return { ok: false, error: "Hesabınız oluşturuldu ancak giriş yapılamadı. Lütfen giriş yapın." };
    }
    throw e;
  }
  return { ok: true };
}

export async function googleSignInAction(formData: FormData): Promise<void> {
  const redirectTo = safeCallbackUrl(formString(formData, "callbackUrl"));
  await signIn("google", { redirectTo });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}

// ------------------------------------------------ mailed account flows ----

/** Writes the verify-email outbox row now; SMTP delivery runs after the response. */
async function queueVerificationMail(userId: string): Promise<boolean> {
  try {
    const { alreadyVerified, deliver } = await sendVerificationEmail(userId);
    if (!alreadyVerified) after(() => deliver());
    return true;
  } catch (e) {
    console.error("[auth] verification mail failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

const forgotSchema = z.object({ email: emailField });

/**
 * Always answers with FORGOT_PASSWORD_MESSAGE (also for unknown addresses and
 * internal failures). Delivery runs after the response, so SMTP latency does
 * not reveal whether a mail was sent.
 */
export async function forgotPasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { email: formString(formData, "email") };
  const parsed = forgotSchema.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Lütfen formdaki hataları düzeltin.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
      values,
    };
  }
  const ip = clientIp(await headers());
  const ipOk = hitRateLimit(`forgot:ip:${ip}`, ACCOUNT_MAIL_LIMITS.forgotPasswordPerIp);
  const emailOk =
    ipOk && hitRateLimit(`forgot:email:${parsed.data.email}`, ACCOUNT_MAIL_LIMITS.forgotPasswordPerEmail);
  if (!ipOk || !emailOk) return { ok: false, error: TOO_MANY_ATTEMPTS, values };

  const result = await requestPasswordReset(parsed.data);
  after(() => result.deliver());
  return { ok: true, message: FORGOT_PASSWORD_MESSAGE };
}

/** Sets the new password, redeems the token and signs this browser out (every JWT is revoked). */
export async function resetPasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await resetPasswordWithToken({
      token: formString(formData, "token"),
      password: formString(formData, "password"),
    });
  } catch (e) {
    return toActionState(e);
  }
  // Clear this browser's (now revoked) cookie so /login does not bounce to /app.
  await signOut({ redirect: false });
  redirect("/login?reset=1");
}

/** POST (not GET) so mail scanners that pre-fetch links do not burn the token. */
export async function verifyEmailAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await verifyEmailWithToken(formString(formData, "token"));
  } catch (e) {
    return toActionState(e);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "E-posta adresiniz doğrulandı." };
}

/** "Tekrar gönder" on the verify-email banner. Rate limited per user. */
export async function resendVerificationAction(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  void _formData;
  const check = await checkSession();
  // Revoked JWT: clear the cookie instead of silently treating it as signed out.
  if (check.status === "revoked") redirect(SESSION_EXPIRED_PATH);
  if (check.status !== "ok") return { ok: false, error: "Oturum açmanız gerekiyor." };
  const user = check.user;
  if (user.emailVerified) return { ok: true, message: "E-posta adresiniz zaten doğrulanmış." };
  if (!hitRateLimit(`verify-resend:user:${user.id}`, ACCOUNT_MAIL_LIMITS.verifyResendPerUser)) {
    return { ok: false, error: TOO_MANY_ATTEMPTS };
  }
  const queued = await queueVerificationMail(user.id);
  if (!queued) return { ok: false, error: "E-posta şu anda gönderilemedi. Lütfen daha sonra tekrar deneyin." };
  return { ok: true, message: `Doğrulama bağlantısı ${user.email} adresine gönderildi.` };
}
