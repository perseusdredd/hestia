"use client";

import { useActionState } from "react";
import Link from "next/link";

import { createDocumentAction, updateDocumentAction } from "@/app/w/[slug]/files/actions";
import { FieldError, FormError } from "@/components/form-error";
import { InternalToggle } from "@/components/internal-toggle";
import { MarkdownEditor } from "@/components/markdown-editor";
import { SubmitButton } from "@/components/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";

/** Create (no `document`) or edit form for a Markdown document. */
export function DocumentForm({
  slug,
  folderId,
  document,
  cancelHref,
  canSetInternal = false,
}: {
  slug: string;
  folderId: string | null;
  document?: { id: string; title: string; content: string; internal?: boolean };
  cancelHref: string;
  /** Shows the "Yalnızca ekip" toggle (not for guests). */
  canSetInternal?: boolean;
}) {
  const action = document ? updateDocumentAction.bind(null, slug) : createDocumentAction.bind(null, slug);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  const title = state.values?.title ?? document?.title ?? "";
  const content = state.values?.content ?? document?.content ?? "";

  return (
    <form action={formAction} className="grid gap-5" noValidate>
      {document ? <input type="hidden" name="id" value={document.id} /> : null}
      {!document ? <input type="hidden" name="folderId" value={folderId ?? ""} /> : null}
      <FormError
        message={state.ok || state.fieldErrors?.title || state.fieldErrors?.content ? undefined : state.error}
      />
      <div className="grid gap-1.5">
        <Label htmlFor="doc-title">Başlık</Label>
        <Input
          id="doc-title"
          name="title"
          required
          maxLength={200}
          defaultValue={title}
          key={`t-${title}`}
          placeholder="Örn. Proje kapsamı"
          aria-invalid={Boolean(state.fieldErrors?.title) || undefined}
        />
        <FieldError errors={state.fieldErrors?.title} />
      </div>
      {canSetInternal ? <InternalToggle id="doc-internal" defaultChecked={Boolean(document?.internal)} /> : null}
      <div className="grid gap-1.5">
        <Label htmlFor="doc-content">İçerik</Label>
        <MarkdownEditor
          id="doc-content"
          name="content"
          rows={18}
          maxLength={100000}
          defaultValue={content}
          key={`c-${content.length}-${content.slice(0, 32)}`}
          placeholder="Notlarınızı, kararları veya taslağı buraya yazın."
          className="min-h-80 font-mono text-sm leading-relaxed"
          aria-invalid={Boolean(state.fieldErrors?.content) || undefined}
        />
        <FieldError errors={state.fieldErrors?.content} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pending={pending} pendingText="Kaydediliyor">
          {document ? "Kaydet" : "Dokümanı oluştur"}
        </SubmitButton>
        <Link href={cancelHref} className={buttonVariants({ variant: "ghost" })}>
          Vazgeç
        </Link>
      </div>
    </form>
  );
}
