"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";

import { FieldError, FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function ProfileForm({
  name,
  email,
  action,
}: {
  name: string;
  email: string;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);

  return (
    <form action={formAction} className="grid max-w-md gap-4" noValidate>
      <div className="grid gap-1.5">
        <Label htmlFor="account-name">Ad</Label>
        <Input
          id="account-name"
          name="name"
          required
          maxLength={80}
          autoComplete="name"
          key={state.values?.name ?? name}
          defaultValue={state.values?.name ?? name}
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <FieldError errors={state.fieldErrors?.name} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="account-email">E-posta</Label>
        <Input id="account-email" value={email} readOnly disabled />
        <p className="text-xs text-muted-foreground">E-posta adresi değiştirilemez.</p>
      </div>
      {!state.ok && !state.fieldErrors?.name ? <FormError message={state.error} /> : null}
      <div>
        <SubmitButton pending={pending} pendingText="Kaydediliyor">
          Kaydet
        </SubmitButton>
      </div>
    </form>
  );
}

export function PasswordForm({ hasPassword, action }: { hasPassword: boolean; action: Action }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);

  const hasFieldErrors = Boolean(state.fieldErrors?.currentPassword || state.fieldErrors?.newPassword);

  return (
    // key remounts the form after success so the password fields are cleared.
    <form
      key={state.ok ? "done" : "edit"}
      action={formAction}
      className="grid max-w-md gap-4"
      noValidate
    >
      {hasPassword ? (
        <div className="grid gap-1.5">
          <Label htmlFor="current-password">Mevcut şifre</Label>
          <Input
            id="current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={Boolean(state.fieldErrors?.currentPassword) || undefined}
          />
          <FieldError errors={state.fieldErrors?.currentPassword} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Hesabınız Google ile oluşturuldu. E-posta ve şifre ile de giriş yapabilmek için bir
          şifre belirleyin.
        </p>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="new-password">Yeni şifre</Label>
        <Input
          id="new-password"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={Boolean(state.fieldErrors?.newPassword) || undefined}
        />
        <FieldError errors={state.fieldErrors?.newPassword} />
        <p className="text-xs text-muted-foreground">En az 8 karakter.</p>
      </div>
      {!state.ok && !hasFieldErrors ? <FormError message={state.error} /> : null}
      <div>
        <SubmitButton pending={pending} pendingText="Güncelleniyor">
          {hasPassword ? "Şifreyi değiştir" : "Şifre belirle"}
        </SubmitButton>
      </div>
    </form>
  );
}
