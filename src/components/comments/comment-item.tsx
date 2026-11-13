"use client";

import { useActionState, useCallback, useEffect, useState, type ReactNode } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { deleteCommentAction, updateCommentAction } from "@/components/comments/actions";
import { ConfirmAction } from "@/components/confirm-action";
import { FieldError, FormError } from "@/components/form-error";
import { MentionEditor, type MentionMember } from "@/components/mention-editor";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { displayName, UserAvatar } from "@/components/user-avatar";
import type { ActionState } from "@/lib/action-state";
import { formatDateTime, formatRelative } from "@/lib/format";

export type CommentView = {
  id: string;
  body: string;
  createdAt: string;
  edited: boolean;
  author: { name: string | null; email: string; image: string | null };
};

function EditCommentForm({
  slug,
  comment,
  members,
  onDone,
}: {
  slug: string;
  comment: CommentView;
  members: MentionMember[];
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateCommentAction.bind(null, slug),
    {},
  );
  useEffect(() => {
    if (state.ok) {
      if (state.message) toast.success(state.message);
      onDone();
    }
  }, [state, onDone]);

  return (
    <form action={action} className="grid gap-3" noValidate>
      <input type="hidden" name="id" value={comment.id} />
      <FormError message={state.ok ? undefined : state.error} />
      <MentionEditor
        name="body"
        required
        rows={3}
        maxLength={5000}
        aria-label="Yorum"
        members={members}
        defaultValue={state.values?.body ?? comment.body}
        aria-invalid={Boolean(state.fieldErrors?.body) || undefined}
      />
      <FieldError errors={state.fieldErrors?.body} />
      <div className="flex items-center gap-2">
        <SubmitButton pending={pending} pendingText="Kaydediliyor" size="sm">
          Kaydet
        </SubmitButton>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Vazgeç
        </Button>
      </div>
    </form>
  );
}

export function CommentItem({
  slug,
  comment,
  canModify,
  members,
  children,
}: {
  slug: string;
  comment: CommentView;
  canModify: boolean;
  members: MentionMember[];
  /**
   * The rendered body (<Markdown> from the server component), so that
   * react-markdown and remark stay out of the client bundle.
   */
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const stopEditing = useCallback(() => setEditing(false), []);

  return (
    <li id={`comment-${comment.id}`} className="flex scroll-mt-20 gap-3">
      <UserAvatar user={comment.author} size="sm" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="text-sm font-medium text-foreground">{displayName(comment.author)}</span>
          <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)}>
            {formatRelative(comment.createdAt)}
          </time>
          {comment.edited ? <span>(düzenlendi)</span> : null}
        </div>
        {editing ? (
          <EditCommentForm slug={slug} comment={comment} members={members} onDone={stopEditing} />
        ) : (
          <>
            {children}
            {canModify ? (
              <div className="flex items-center gap-1 pt-0.5">
                <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(true)}>
                  <Pencil aria-hidden />
                  Düzenle
                </Button>
                <ConfirmAction
                  action={deleteCommentAction.bind(null, slug)}
                  fields={{ id: comment.id }}
                  title="Yorum silinsin mi?"
                  description="Bu işlem geri alınamaz."
                  confirmLabel="Sil"
                  triggerSize="xs"
                  trigger={
                    <>
                      <Trash2 aria-hidden />
                      Sil
                    </>
                  }
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}
