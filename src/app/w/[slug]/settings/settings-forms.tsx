"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmAction } from "@/components/confirm-action";
import { CopyButton } from "@/components/copy-button";
import { FieldError, FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";
import { ROLE_LABELS, type Role } from "@/lib/roles";
import { NOTIFICATION_TYPE_LABELS } from "@/lib/notification-type-labels";
import type { NotificationType } from "@/server/notifications";

import {
  changeRoleAction,
  createCategoryAction,
  createInviteLinkAction,
  deleteCategoryAction,
  moveCategoryAction,
  updateCategoryAction,
  deleteWorkspaceAction,
  inviteMemberAction,
  renameWorkspaceAction,
  saveNotificationPreferencesAction,
  type InviteResult,
} from "./actions";

export function InviteForm({ slug, assignableRoles }: { slug: string; assignableRoles: Role[] }) {
  const [state, action, pending] = useActionState<ActionState<InviteResult>, FormData>(
    inviteMemberAction.bind(null, slug),
    {},
  );

  return (
    <div className="grid gap-4">
      <form action={action} className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-start" noValidate>
        <div className="grid gap-1.5">
          <Label htmlFor="invite-email" className="sr-only">
            E-posta
          </Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            placeholder="ornek@firma.com"
            autoComplete="off"
            key={state.ok ? `ok-${state.data?.inviteUrl}` : `v-${state.values?.email ?? ""}`}
            defaultValue={state.ok ? "" : state.values?.email}
            aria-invalid={Boolean(state.fieldErrors?.email) || undefined}
          />
          <FieldError errors={state.fieldErrors?.email} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="invite-role" className="sr-only">
            Rol
          </Label>
          <NativeSelect
            id="invite-role"
            name="role"
            key={`r-${state.values?.role ?? ""}`}
            defaultValue={state.values?.role || "MEMBER"}
          >
            {assignableRoles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
          <FieldError errors={state.fieldErrors?.role} />
        </div>
        <SubmitButton pending={pending} pendingText="Davet oluşturuluyor">
          Davet et
        </SubmitButton>
      </form>

      {!state.ok ? <FormError message={state.fieldErrors?.email ? undefined : state.error} /> : null}

      {state.ok && state.data ? (
        <div className="grid gap-2 rounded-lg border bg-muted/40 p-3">
          <p className="text-sm">
            <span className="font-medium">{state.data.email}</span> için davet bağlantısı hazır.{" "}
            {state.data.emailStatus === "failed"
              ? "Davet e-postası gönderilemedi; bu bağlantıyı kişiye siz iletin."
              : "Davet e-posta ile de gönderildi. Bağlantı yalnızca bir kez gösterilir ve 7 gün geçerlidir."}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              readOnly
              value={state.data.inviteUrl}
              aria-label="Davet bağlantısı"
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
            />
            <CopyButton value={state.data.inviteUrl} label="Bağlantıyı kopyala" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Creates a reusable invite link: no e-mail address, any number of people can join with it. */
export function InviteLinkForm({ slug, assignableRoles }: { slug: string; assignableRoles: Role[] }) {
  const [state, action, pending] = useActionState<ActionState<{ id: string }>, FormData>(
    createInviteLinkAction.bind(null, slug),
    {},
  );
  const roles = assignableRoles.filter((r) => r !== "OWNER");
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);
  return (
    <div className="grid gap-3">
      <form action={action} className="grid gap-3 sm:grid-cols-[10rem_auto] sm:items-start">
        <div className="grid gap-1.5">
          <Label htmlFor="invite-link-role" className="sr-only">
            Bağlantıyla katılanların rolü
          </Label>
          <NativeSelect id="invite-link-role" name="role" defaultValue="MEMBER">
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <SubmitButton pending={pending} pendingText="Oluşturuluyor" variant="outline">
          Davet bağlantısı oluştur
        </SubmitButton>
      </form>
      {!state.ok ? <FormError message={state.error} /> : null}
    </div>
  );
}

/** One copyable invite link (read-only field + copy button). */
export function InviteLinkField({ url }: { url: string }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Input
        readOnly
        value={url}
        aria-label="Herkese açık davet bağlantısı"
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-xs"
      />
      <CopyButton value={url} label="Bağlantıyı kopyala" />
    </div>
  );
}

export function RoleSelect({
  slug,
  membershipId,
  role,
  options,
  memberLabel,
}: {
  slug: string;
  membershipId: string;
  role: Role;
  options: Role[];
  memberLabel: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<ActionState, FormData>(
    changeRoleAction.bind(null, slug),
    {},
  );

  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
    if (state.ok === false && state.error) toast.error(state.error);
  }, [state]);

  return (
    <form ref={formRef} action={action}>
      <input type="hidden" name="id" value={membershipId} />
      <NativeSelect
        name="role"
        // Re-mount after each result so a rejected change snaps back to the stored role.
        key={`${role}-${JSON.stringify(state)}`}
        defaultValue={role}
        disabled={pending}
        aria-label={`${memberLabel} rolü`}
        className="w-32"
        onChange={() => formRef.current?.requestSubmit()}
      >
        {options.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </NativeSelect>
    </form>
  );
}

export function RenameWorkspaceForm({ slug, name }: { slug: string; name: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    renameWorkspaceAction.bind(null, slug),
    {},
  );
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);

  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start" noValidate>
      <div className="grid gap-1.5">
        <Label htmlFor="ws-name" className="sr-only">
          Çalışma alanı adı
        </Label>
        <Input
          id="ws-name"
          name="name"
          required
          maxLength={60}
          key={state.values?.name ?? name}
          defaultValue={state.values?.name ?? name}
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <FieldError errors={state.fieldErrors?.name} />
        {!state.ok && !state.fieldErrors?.name ? <FormError message={state.error} /> : null}
      </div>
      <SubmitButton pending={pending} variant="outline">
        Kaydet
      </SubmitButton>
    </form>
  );
}

export function DeleteWorkspaceForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    deleteWorkspaceAction.bind(null, slug),
    {},
  );
  const [typed, setTyped] = useState("");
  const matches = typed.trim().toLowerCase() === slug;

  return (
    <form action={action} className="grid gap-3 sm:max-w-md" noValidate>
      <div className="grid gap-1.5">
        <Label htmlFor="delete-confirm">
          Onaylamak için <span className="font-mono font-semibold">{slug}</span> yazın
        </Label>
        <Input
          id="delete-confirm"
          name="confirmSlug"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-invalid={Boolean(state.fieldErrors?.confirmSlug) || undefined}
        />
        <FieldError errors={state.fieldErrors?.confirmSlug} />
      </div>
      {!state.ok && !state.fieldErrors?.confirmSlug ? <FormError message={state.error} /> : null}
      <div>
        <SubmitButton
          pending={pending}
          pendingText="Siliniyor"
          variant="destructive"
          disabled={!matches}
        >
          Çalışma alanını kalıcı olarak sil
        </SubmitButton>
      </div>
    </form>
  );
}

export function NotificationPreferencesForm({ slug, muted }: { slug: string; muted: string[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    saveNotificationPreferencesAction.bind(null, slug),
    {},
  );
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);
  return (
    <form action={action} className="grid gap-3">
      <ul className="grid gap-2">
        {(Object.keys(NOTIFICATION_TYPE_LABELS) as NotificationType[]).map((type) => (
          <li key={type}>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                name="enabled"
                value={type}
                defaultChecked={!muted.includes(type)}
                className="size-4"
              />
              {NOTIFICATION_TYPE_LABELS[type]}
            </label>
          </li>
        ))}
      </ul>
      {!state.ok ? <FormError message={state.error} /> : null}
      <div>
        <SubmitButton pending={pending} pendingText="Kaydediliyor">
          Kaydet
        </SubmitButton>
      </div>
    </form>
  );
}

export function CategoryCreateForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createCategoryAction.bind(null, slug), {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      if (state.message) toast.success(state.message);
    }
  }, [state]);

  return (
    <form ref={formRef} action={action} className="grid gap-3 sm:grid-cols-[5rem_1fr_auto] sm:items-start" noValidate>
      <div className="grid gap-1.5">
        <Label htmlFor="cat-new-emoji" className="sr-only">
          Emoji
        </Label>
        <Input id="cat-new-emoji" name="emoji" required maxLength={16} placeholder="🙂" autoComplete="off" />
        <FieldError errors={state.fieldErrors?.emoji} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="cat-new-name" className="sr-only">
          Kategori adı
        </Label>
        <Input id="cat-new-name" name="name" required maxLength={40} placeholder="Yeni kategori adı" autoComplete="off" />
        <FieldError errors={state.fieldErrors?.name} />
        {!state.ok && !state.fieldErrors ? <FormError message={state.error} /> : null}
      </div>
      <SubmitButton pending={pending} variant="outline">
        Ekle
      </SubmitButton>
    </form>
  );
}

export function CategoryRow({
  slug,
  category,
  isFirst,
  isLast,
}: {
  slug: string;
  category: { id: string; name: string; emoji: string };
  isFirst: boolean;
  isLast: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateCategoryAction.bind(null, slug), {});
  const [, moveAction, movePending] = useActionState<ActionState, FormData>(moveCategoryAction.bind(null, slug), {});
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);

  return (
    <li className="grid gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <form action={action} className="flex min-w-0 flex-1 flex-wrap items-center gap-2" noValidate>
          <input type="hidden" name="id" value={category.id} />
          <Input
            name="emoji"
            aria-label={`${category.name} emojisi`}
            className="w-16"
            required
            maxLength={16}
            key={`e-${category.emoji}`}
            defaultValue={category.emoji}
          />
          <Input
            name="name"
            aria-label={`${category.name} adı`}
            className="min-w-40 flex-1"
            required
            maxLength={40}
            key={`n-${category.name}`}
            defaultValue={category.name}
          />
          <SubmitButton pending={pending} variant="outline" size="sm">
            Kaydet
          </SubmitButton>
        </form>
        <form action={moveAction} className="flex gap-1">
          <input type="hidden" name="id" value={category.id} />
          <Button
            type="submit"
            name="direction"
            value="up"
            variant="ghost"
            size="icon-sm"
            disabled={isFirst || movePending}
            aria-label={`${category.name} kategorisini yukarı taşı`}
          >
            <ArrowUp aria-hidden />
          </Button>
          <Button
            type="submit"
            name="direction"
            value="down"
            variant="ghost"
            size="icon-sm"
            disabled={isLast || movePending}
            aria-label={`${category.name} kategorisini aşağı taşı`}
          >
            <ArrowDown aria-hidden />
          </Button>
        </form>
        <ConfirmAction
          action={deleteCategoryAction.bind(null, slug)}
          fields={{ id: category.id }}
          title={`"${category.name}" kategorisi silinsin mi?`}
          description="Bu kategorideki mesajlar silinmez; yalnızca kategorisiz kalır."
          confirmLabel="Kategoriyi sil"
          successMessage="Kategori silindi."
          trigger={<Trash2 aria-hidden />}
          triggerSize="icon-sm"
          triggerLabel={`${category.name} kategorisini sil`}
        />
      </div>
      {!state.ok && state.error ? <FormError message={state.error} /> : null}
      <FieldError errors={state.fieldErrors?.name} />
    </li>
  );
}
