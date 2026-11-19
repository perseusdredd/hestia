"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";

import { FieldError, FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";

import { createProjectFromTemplateAction, createTemplateAction, renameTemplateAction } from "./actions";

function useToastOnOk(state: ActionState) {
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);
}

export function NewTemplateForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createTemplateAction.bind(null, slug), {});
  useToastOnOk(state);
  return (
    <form action={action} className="grid max-w-xl gap-2" key={state.ok ? "done" : "open"} noValidate>
      <FormError message={state.ok || state.fieldErrors?.name ? undefined : state.error} />
      <Label htmlFor="new-template-name">Boş şablon</Label>
      <div className="flex gap-2">
        <Input
          id="new-template-name"
          name="name"
          required
          maxLength={80}
          placeholder="Örn. Müşteri başlangıç paketi"
          defaultValue={state.values?.name ?? ""}
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <SubmitButton pending={pending} pendingText="Oluşturuluyor" variant="outline">
          Şablon oluştur
        </SubmitButton>
      </div>
      <FieldError errors={state.fieldErrors?.name} />
    </form>
  );
}

export function UseTemplateForm({ slug, template }: { slug: string; template: { id: string; name: string } }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createProjectFromTemplateAction.bind(null, slug),
    {},
  );
  useToastOnOk(state);
  const inputId = `from-template-${template.id}`;
  return (
    <form action={action} className="grid gap-1.5" key={state.ok ? "done" : "open"} noValidate>
      <input type="hidden" name="id" value={template.id} />
      <FormError message={state.ok || state.fieldErrors?.name ? undefined : state.error} />
      <Label htmlFor={inputId} className="sr-only">
        Yeni proje adı
      </Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          name="name"
          required
          maxLength={80}
          placeholder="Yeni proje adı"
          defaultValue={state.values?.name ?? ""}
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <SubmitButton pending={pending} pendingText="Oluşturuluyor">
          Şablondan proje oluştur
        </SubmitButton>
      </div>
      <FieldError errors={state.fieldErrors?.name} />
    </form>
  );
}

export function RenameTemplateForm({ slug, template }: { slug: string; template: { id: string; name: string } }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(renameTemplateAction.bind(null, slug), {});
  useToastOnOk(state);
  const inputId = `rename-template-${template.id}`;
  return (
    <form action={action} className="grid gap-1.5" noValidate>
      <input type="hidden" name="id" value={template.id} />
      <FormError message={state.ok || state.fieldErrors?.name ? undefined : state.error} />
      <Label htmlFor={inputId} className="sr-only">
        Şablon adı
      </Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          name="name"
          required
          maxLength={80}
          defaultValue={state.values?.name ?? template.name}
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <SubmitButton pending={pending} pendingText="Kaydediliyor" variant="outline">
          Yeniden adlandır
        </SubmitButton>
      </div>
      <FieldError errors={state.fieldErrors?.name} />
    </form>
  );
}
