"use client";

import { useActionState, useEffect, useMemo } from "react";
import { toast } from "sonner";

import { deleteChatMessageAction } from "@/app/w/[slug]/chat/actions";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ActionState } from "@/lib/action-state";

/** Mount with key={messageId} so each target starts with a fresh action state. */
export function DeleteMessageDialog({
  slug,
  messageId,
  preview,
  onClose,
  onDeleted,
}: {
  slug: string;
  messageId: string;
  preview: string;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const action = useMemo(() => deleteChatMessageAction.bind(null, slug), [slug]);
  const [state, formAction, pending] = useActionState<ActionState<{ id: string }>, FormData>(action, {});

  useEffect(() => {
    if (state.ok && state.data) {
      onDeleted(state.data.id);
      toast.success("Mesaj silindi.");
      onClose();
    }
  }, [state, onDeleted, onClose]);

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <form action={formAction} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Mesaj silinsin mi?</DialogTitle>
            <DialogDescription>Mesaj herkes için kaldırılır. Bu işlem geri alınamaz.</DialogDescription>
          </DialogHeader>
          <blockquote className="line-clamp-3 rounded-lg border-l-2 bg-muted/50 px-3 py-2 text-sm break-words whitespace-pre-wrap text-muted-foreground">
            {preview}
          </blockquote>
          <input type="hidden" name="id" value={messageId} />
          <FormError message={state.ok ? undefined : state.error} />
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Vazgeç</DialogClose>
            <SubmitButton pending={pending} pendingText="Siliniyor…" variant="destructive">
              Sil
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
