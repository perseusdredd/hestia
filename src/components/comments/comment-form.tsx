"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { addCommentAction } from "@/components/comments/actions";
import { FieldError, FormError } from "@/components/form-error";
import { MentionEditor, type MentionMember } from "@/components/mention-editor";
import { SubmitButton } from "@/components/submit-button";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";
import type { CommentSubjectType } from "@/server/comments";

export function CommentForm({
  slug,
  subject,
  members,
}: {
  slug: string;
  subject: { type: CommentSubjectType; id: string };
  members: MentionMember[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    addCommentAction.bind(null, slug, subject.type, subject.id),
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      if (state.message) toast.success(state.message);
    }
  }, [state]);

  const fieldId = `comment-body-${subject.type}`;
  return (
    <form ref={formRef} action={action} className="grid gap-3" noValidate>
      <FormError message={state.ok ? undefined : state.error} />
      <div className="grid gap-1.5">
        <Label htmlFor={fieldId}>Yorum ekle</Label>
        <MentionEditor
          id={fieldId}
          name="body"
          required
          rows={3}
          maxLength={5000}
          members={members}
          placeholder="Yorumunuzu yazın. Birinden bahsetmek için @ yazın."
          defaultValue={state.ok ? "" : state.values?.body}
          key={state.ok ? "ok" : `v-${state.values?.body ?? ""}`}
          aria-invalid={Boolean(state.fieldErrors?.body) || undefined}
        />
        <FieldError errors={state.fieldErrors?.body} />
      </div>
      <div>
        <SubmitButton pending={pending} pendingText="Gönderiliyor">
          Yorum yap
        </SubmitButton>
      </div>
    </form>
  );
}
