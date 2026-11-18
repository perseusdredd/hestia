"use client";

import { useActionState, useCallback, useEffect, useState } from "react";
import { Pencil, Pin, PinOff, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  deletePostAction,
  publishPostAction,
  togglePinAction,
  updatePostAction,
} from "@/app/w/[slug]/messages/actions";
import { ConfirmAction } from "@/components/confirm-action";
import type { MentionMember } from "@/components/mention-editor";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/action-state";
import type { MessageCategoryDto } from "@/server/message-categories";

import { PostForm } from "./post-form";

function PinButton({ slug, postId, pinned }: { slug: string; postId: string; pinned: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    togglePinAction.bind(null, slug),
    {},
  );
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
    else if (state.error) toast.error(state.error);
  }, [state]);

  return (
    <form action={action}>
      <input type="hidden" name="id" value={postId} />
      <input type="hidden" name="pinned" value={pinned ? "false" : "true"} />
      <Button type="submit" variant="outline" size="sm" disabled={pending} aria-busy={pending}>
        {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
        {pinned ? "Sabitlemeyi kaldır" : "Sabitle"}
      </Button>
    </form>
  );
}

function PublishButton({ slug, postId }: { slug: string; postId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    publishPostAction.bind(null, slug),
    {},
  );
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
    else if (state.error) toast.error(state.error);
  }, [state]);

  return (
    <form action={action}>
      <input type="hidden" name="id" value={postId} />
      <Button type="submit" size="sm" disabled={pending} aria-busy={pending}>
        <Send aria-hidden />
        Yayınla
      </Button>
    </form>
  );
}

/**
 * Wraps the read-only post content (`children`, rendered on the server) and
 * swaps it for an edit form on demand. Buttons are shown according to the
 * flags, but the server actions enforce permissions again.
 */
export function PostControls({
  slug,
  post,
  canModify,
  canPin,
  members = [],
  categories = [],
  canSetInternal = false,
  children,
}: {
  slug: string;
  post: {
    id: string;
    title: string;
    body: string;
    pinned: boolean;
    categoryId: string | null;
    isDraft: boolean;
    internal?: boolean;
  };
  canModify: boolean;
  canPin: boolean;
  /** Offered when typing "@" while editing the body. */
  members?: MentionMember[];
  categories?: MessageCategoryDto[];
  /** Shows the "Yalnızca ekip" toggle while editing (not for guests). */
  canSetInternal?: boolean;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const stopEditing = useCallback(() => setEditing(false), []);

  if (editing) {
    return (
      <PostForm
        action={updatePostAction.bind(null, slug)}
        post={post}
        submitLabel="Kaydet"
        onDone={stopEditing}
        members={members}
        categories={categories}
        canSetInternal={canSetInternal}
        cancel={
          <Button type="button" variant="ghost" onClick={stopEditing}>
            Vazgeç
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {canModify || canPin ? (
        <div className="flex flex-wrap items-center gap-2">
          {post.isDraft && canModify ? <PublishButton slug={slug} postId={post.id} /> : null}
          {canPin ? <PinButton slug={slug} postId={post.id} pinned={post.pinned} /> : null}
          {canModify ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
                Düzenle
              </Button>
              <ConfirmAction
                action={deletePostAction.bind(null, slug)}
                fields={{ id: post.id }}
                title="Gönderi silinsin mi?"
                description="Gönderi ve yorumları çöp kutusuna taşınır; 30 gün içinde geri yüklenebilir."
                confirmLabel="Sil"
                triggerVariant="outline"
                trigger={
                  <>
                    <Trash2 aria-hidden />
                    Sil
                  </>
                }
              />
            </>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
