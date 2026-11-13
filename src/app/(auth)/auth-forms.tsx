"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FieldError, FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";

import { buttonVariants } from "@/components/ui/button";

import {
  forgotPasswordAction,
  loginAction,
  registerAction,
  resetPasswordAction,
  verifyEmailAction,
} from "./actions";

function withCallback(path: string, callbackUrl?: string) {
  return callbackUrl && callbackUrl !== "/app"
    ? `${path}?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : path;
}

export function LoginForm({
  callbackUrl,
  initialError,
  defaultEmail,
}: {
  callbackUrl: string;
  initialError?: string;
  defaultEmail?: string;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(loginAction, {
    error: initialError,
  });
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <FormError message={state.error} />
      <div className="grid gap-2">
        <Label htmlFor="email">E-posta</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          key={state.values?.email}
          defaultValue={state.values?.email ?? defaultEmail}
          aria-invalid={Boolean(state.fieldErrors?.email) || undefined}
        />
        <FieldError errors={state.fieldErrors?.email} />
      </div>
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="password">Şifre</Label>
          <Link
            href="/forgot-password"
            className="inline-flex min-h-6 items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline pointer-coarse:min-h-10"
          >
            Şifremi unuttum
          </Link>
        </div>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={Boolean(state.fieldErrors?.password) || undefined}
        />
        <FieldError errors={state.fieldErrors?.password} />
      </div>
      <SubmitButton pending={pending} pendingText="Giriş yapılıyor" size="lg" className="w-full">
        Giriş yap
      </SubmitButton>
      <p className="text-center text-sm text-muted-foreground">
        Hesabınız yok mu?{" "}
        <Link
          href={withCallback("/register", callbackUrl)}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Kayıt olun
        </Link>
      </p>
    </form>
  );
}

export function RegisterForm({
  callbackUrl,
  defaultEmail,
}: {
  callbackUrl: string;
  defaultEmail?: string;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(registerAction, {});
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <FormError message={state.error} />
      <div className="grid gap-2">
        <Label htmlFor="name">Ad soyad</Label>
        <Input
          id="name"
          name="name"
          autoComplete="name"
          required
          key={`n-${state.values?.name ?? ""}`}
          defaultValue={state.values?.name}
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <FieldError errors={state.fieldErrors?.name} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="email">E-posta</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          key={`e-${state.values?.email ?? ""}`}
          defaultValue={state.values?.email ?? defaultEmail}
          aria-invalid={Boolean(state.fieldErrors?.email) || undefined}
        />
        <FieldError errors={state.fieldErrors?.email} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">Şifre</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          aria-invalid={Boolean(state.fieldErrors?.password) || undefined}
          aria-describedby="password-hint"
        />
        {state.fieldErrors?.password ? (
          <FieldError errors={state.fieldErrors.password} />
        ) : (
          <p id="password-hint" className="text-xs text-muted-foreground">
            En az 8 karakter; en fazla 72 bayt (Türkçe harfler 2 bayt sayılır).
          </p>
        )}
      </div>
      <SubmitButton pending={pending} pendingText="Hesap oluşturuluyor" size="lg" className="w-full">
        Hesap oluştur
      </SubmitButton>
      <p className="text-center text-sm text-muted-foreground">
        Zaten hesabınız var mı?{" "}
        <Link
          href={withCallback("/login", callbackUrl)}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Giriş yapın
        </Link>
      </p>
    </form>
  );
}

/** Success notice above a form (role=status so screen readers announce it). */
export function FormNotice({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-success/30 bg-success-soft px-3 py-2 text-sm text-success"
    >
      {message}
    </div>
  );
}

export function ForgotPasswordForm({ defaultEmail }: { defaultEmail?: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(forgotPasswordAction, {});
  if (state.ok) {
    return (
      <div className="grid gap-4">
        <FormNotice message={state.message} />
        <Link href="/login" className={buttonVariants({ variant: "outline", size: "lg" })}>
          Giriş sayfasına dön
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormError message={state.error} />
      <div className="grid gap-2">
        <Label htmlFor="email">E-posta</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          key={state.values?.email}
          defaultValue={state.values?.email ?? defaultEmail}
          aria-invalid={Boolean(state.fieldErrors?.email) || undefined}
        />
        <FieldError errors={state.fieldErrors?.email} />
      </div>
      <SubmitButton pending={pending} pendingText="Gönderiliyor" size="lg" className="w-full">
        Sıfırlama bağlantısı gönder
      </SubmitButton>
      <p className="text-center text-sm text-muted-foreground">
        Şifrenizi hatırladınız mı?{" "}
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          Giriş yapın
        </Link>
      </p>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(resetPasswordAction, {});
  // An error without a password field error is the (generic) token error.
  const tokenError = Boolean(state.error) && !state.fieldErrors?.password;
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="token" value={token} />
      <FormError message={state.error} />
      {tokenError ? (
        <Link href="/forgot-password" className={buttonVariants({ variant: "outline", size: "lg" })}>
          Yeni bağlantı iste
        </Link>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="password">Yeni şifre</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          aria-invalid={Boolean(state.fieldErrors?.password) || undefined}
          aria-describedby="password-hint"
        />
        {state.fieldErrors?.password ? (
          <FieldError errors={state.fieldErrors.password} />
        ) : (
          <p id="password-hint" className="text-xs text-muted-foreground">
            En az 8 karakter; en fazla 72 bayt (Türkçe harfler 2 bayt sayılır).
          </p>
        )}
      </div>
      <SubmitButton pending={pending} pendingText="Kaydediliyor" size="lg" className="w-full">
        Şifremi güncelle
      </SubmitButton>
    </form>
  );
}

export function VerifyEmailForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(verifyEmailAction, {});
  if (state.ok) {
    return (
      <div className="grid gap-4">
        <FormNotice message={state.message} />
        <Link href="/app" className={buttonVariants({ size: "lg" })}>
          Uygulamaya devam et
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      <FormError message={state.error} />
      {state.error ? (
        <p className="text-sm text-muted-foreground">
          Oturum açtıysanız uygulamadaki uyarıdan yeni bir doğrulama bağlantısı isteyebilirsiniz.
        </p>
      ) : null}
      <SubmitButton pending={pending} pendingText="Doğrulanıyor" size="lg" className="w-full">
        E-postamı doğrula
      </SubmitButton>
    </form>
  );
}
