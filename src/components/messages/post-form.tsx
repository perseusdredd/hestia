"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";

import { FieldError, FormError } from "@/components/form-error";
import { MentionEditor, type MentionMember } from "@/components/mention-editor";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";
import { ProjectSelect, type ProjectOption } from "@/components/project-select";
import type { MessageCategoryDto } from "@/server/message-categories";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * Create (no `post`) or edit (with `post`) form for a message board post.
 * New posts offer "Yayınla" and "Taslak olarak kaydet"; a draft being edited
 * offers "Kaydet" (stays a draft) and "Yayınla".
 */
export function PostForm({
  action,
  post,
  submitLabel,
  onDone,
  cancel,
  members = [],
  categories = [],
  projects = [],
}: {
  action: Action;
  post?: { id: string; title: string; body: string; categoryId?: string | null; isDraft?: boolean };
  submitLabel: string;
  onDone?: () => void;
  cancel?: React.ReactNode;
  /** Offered when typing "@" in the body. */
  members?: MentionMember[];
  categories?: MessageCategoryDto[];
  /** Offered only when creating (no `post`). */
  projects?: ProjectOption[];
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
  const categoryId = state.values?.categoryId ?? post?.categoryId ?? "";
  const isDraft = Boolean(post?.isDraft);
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
      {categories.length > 0 ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-category`}>Kategori</Label>
          <NativeSelect
            className="max-w-xs"
            id={`${idPrefix}-category`}
            name="categoryId"
            defaultValue={categoryId}
            key={`c-${categoryId}`}
            aria-invalid={Boolean(state.fieldErrors?.categoryId) || undefined}
          >
            <option value="">Kategorisiz</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.emoji} {c.name}
              </option>
            ))}
          </NativeSelect>
          <FieldError errors={state.fieldErrors?.categoryId} />
        </div>
      ) : null}
      {post ? null : (
        <ProjectSelect
          projects={projects}
          id={`${idPrefix}-project`}
          defaultValue={state.values?.projectId ?? ""}
          errors={state.fieldErrors?.projectId}
        />
      )}
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
        {post && !isDraft ? (
          <SubmitButton pending={pending} pendingText="Kaydediliyor">
            {submitLabel}
          </SubmitButton>
        ) : (
          <>
            <SubmitButton pending={pending} pendingText="Kaydediliyor" name="intent" value="publish">
              Yayınla
            </SubmitButton>
            <SubmitButton
              pending={pending}
              pendingText="Kaydediliyor"
              name="intent"
              value={post ? "save" : "draft"}
              variant="outline"
            >
              {post ? "Taslağı kaydet" : "Taslak olarak kaydet"}
            </SubmitButton>
          </>
        )}
        {cancel}
      </div>
    </form>
  );
}
