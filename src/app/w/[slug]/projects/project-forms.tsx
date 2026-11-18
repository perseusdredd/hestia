"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";

import { FieldError, FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionState } from "@/lib/action-state";

import { createProjectAction, renameProjectAction } from "./actions";

function useToastOnOk(state: ActionState) {
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);
}

export function NewProjectForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createProjectAction.bind(null, slug), {});
  useToastOnOk(state);
  return (
    <form action={action} className="grid max-w-xl gap-3" key={state.ok ? "done" : "open"} noValidate>
      <FormError message={state.ok || state.fieldErrors?.name ? undefined : state.error} />
      <div className="grid gap-1.5">
        <Label htmlFor="new-project-name">Yeni proje</Label>
        <Input
          id="new-project-name"
          name="name"
          required
          maxLength={80}
          placeholder="Örn. Web sitesi yenileme"
          defaultValue={state.values?.name ?? ""}
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <FieldError errors={state.fieldErrors?.name} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new-project-desc">Açıklama (isteğe bağlı)</Label>
        <Textarea
          id="new-project-desc"
          name="description"
          rows={2}
          maxLength={2000}
          defaultValue={state.values?.description ?? ""}
          aria-invalid={Boolean(state.fieldErrors?.description) || undefined}
        />
        <FieldError errors={state.fieldErrors?.description} />
      </div>
      <div>
        <SubmitButton pending={pending} pendingText="Oluşturuluyor">
          Proje oluştur
        </SubmitButton>
      </div>
    </form>
  );
}

export function RenameProjectForm({
  slug,
  project,
}: {
  slug: string;
  project: { id: string; name: string; description: string | null };
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(renameProjectAction.bind(null, slug), {});
  useToastOnOk(state);
  return (
    <form action={action} className="grid max-w-xl gap-3" noValidate>
      <input type="hidden" name="id" value={project.id} />
      <FormError message={state.ok || state.fieldErrors?.name ? undefined : state.error} />
      <div className="grid gap-1.5">
        <Label htmlFor="rename-project-name">Proje adı</Label>
        <Input
          id="rename-project-name"
          name="name"
          required
          maxLength={80}
          defaultValue={state.values?.name ?? project.name}
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <FieldError errors={state.fieldErrors?.name} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="rename-project-desc">Açıklama</Label>
        <Textarea
          id="rename-project-desc"
          name="description"
          rows={2}
          maxLength={2000}
          defaultValue={state.values?.description ?? project.description ?? ""}
        />
        <FieldError errors={state.fieldErrors?.description} />
      </div>
      <div>
        <SubmitButton pending={pending} pendingText="Kaydediliyor" variant="outline">
          Kaydet
        </SubmitButton>
      </div>
    </form>
  );
}
