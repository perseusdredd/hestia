"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";

import { FieldError, FormError } from "@/components/form-error";
import { MentionEditor, type MentionMember } from "@/components/mention-editor";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Create (no `post`) or edit (with `post`) form for a message board post. */
export function PostForm({
  action,
  post,
  submitLabel,
  onDone,
  cancel,
  members = [],
}: {
  action: Action;
  post?: { id: string; title: string; body: string };
  submitLabel: string;
  onDone?: () => void;
  cancel?: React.ReactNode;
  /** Offered when typing "@" in the body. */
  members?: MentionMember[];
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});

  useEffect(() => {
    if (state.ok) {
      if (state.message) toast.success(state.message);
      onDone?.();
    }
  }, [state, onDone]);

  const title = state.values?.title ?? post?.title ?? "";
  const body = state.values?.body ?? post?.body ?? "";
  const idPrefix = post ? `edit-${post.id}` : "new-post";

  return (
    <form action={formAction} className="grid gap-4" noValidate>
      {post ? <input type="hidden" name="id" value={post.id} /> : null}
      <FormError message={state.ok ? undefined : state.error} />
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-title`}>Başlık</Label>
        <Input
          id={`${idPrefix}-title`}
          name="title"
          required
          maxLength={200}
          defaultValue={title}
          key={`t-${title}`}
          placeholder="Örn. Haftalık durum güncellemesi"
          aria-invalid={Boolean(state.fieldErrors?.title) || undefined}
        />
        <FieldError errors={state.fieldErrors?.title} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-body`}>Mesaj</Label>
        <MentionEditor
          id={`${idPrefix}-body`}
          members={members}
          name="body"
          required
          rows={8}
          maxLength={20000}
          defaultValue={body}
          key={`b-${body}`}
          placeholder="Ekibinizle paylaşmak istediğiniz her şeyi yazın. Birinden bahsetmek için @ yazın."
          aria-invalid={Boolean(state.fieldErrors?.body) || undefined}
        />
        <FieldError errors={state.fieldErrors?.body} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pending={pending} pendingText="Kaydediliyor">
          {submitLabel}
        </SubmitButton>
        {cancel}
      </div>
    </form>
  );
}
