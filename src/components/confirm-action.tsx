"use client";

import { useState } from "react";

import { DeferredMenu } from "@/components/deferred-menu";
import { Button } from "@/components/ui/button";
import { useActionFeedback } from "@/components/use-action-feedback";
import type { ActionState } from "@/lib/action-state";

/**
 * Button that opens a confirmation dialog and then submits a server action.
 * `action` is a useActionState-compatible server action; `fields` are posted
 * as hidden inputs (e.g. { id }). Closes and toasts `successMessage` on ok.
 *
 *   <ConfirmAction action={deletePost.bind(null, slug)} fields={{ id: post.id }}
 *     title="Gönderi silinsin mi?" confirmLabel="Sil" trigger={<Trash2 />} />
 *
 * The dialog's code (base-ui Dialog + floating-ui focus management) loads
 * after hydration, like the dropdown menus (DeferredMenu); a press before it
 * arrives opens the dialog as soon as it does.
 */
export type ConfirmDialogProps = {
  open: boolean;
  setOpen: (open: boolean) => void;
  formAction: (formData: FormData) => void;
  pending: boolean;
  error?: string;
  fields?: Record<string, string>;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  destructive: boolean;
  trigger: React.ReactNode;
  triggerVariant: React.ComponentProps<typeof Button>["variant"];
  triggerSize: React.ComponentProps<typeof Button>["size"];
  triggerLabel?: string;
};

const loadDialog = () => import("@/components/confirm-dialog").then((m) => m.ConfirmDialog);

export function ConfirmAction({
  action,
  fields,
  title,
  description,
  confirmLabel = "Onayla",
  successMessage,
  trigger,
  triggerVariant = "ghost",
  triggerSize = "sm",
  triggerLabel,
  destructive = true,
  onSuccess,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  fields?: Record<string, string>;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  successMessage?: string;
  trigger: React.ReactNode;
  triggerVariant?: React.ComponentProps<typeof Button>["variant"];
  triggerSize?: React.ComponentProps<typeof Button>["size"];
  /** Accessible label when the trigger is icon-only. */
  triggerLabel?: string;
  destructive?: boolean;
  /** Called after a successful action (e.g. to close a parent dialog). */
  onSuccess?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Feedback runs inside the action: deleting a row usually unmounts this
  // component in the same render that delivers the result.
  const [state, formAction, pending] = useActionFeedback(action, {
    successMessage,
    onSuccess: () => {
      setOpen(false);
      onSuccess?.();
    },
  });

  const dialogProps: ConfirmDialogProps = {
    open,
    setOpen,
    formAction,
    pending,
    error: state.ok ? undefined : state.error,
    fields,
    title,
    description,
    confirmLabel,
    destructive,
    triggerLabel,
    triggerVariant,
    triggerSize,
    trigger,
  };
  return (
    <DeferredMenu
      load={loadDialog}
      props={dialogProps}
      onRequestOpen={() => setOpen(true)}
      placeholder={(p) => (
        <Button {...p} aria-haspopup="dialog" variant={triggerVariant} size={triggerSize} aria-label={triggerLabel}>
          {trigger}
        </Button>
      )}
    />
  );
}
