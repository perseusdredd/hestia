"use client";

import { Trash2, Undo2 } from "lucide-react";

import { purgeTrashAction, restoreTrashAction } from "@/app/w/[slug]/trash/actions";
import { ConfirmAction } from "@/components/confirm-action";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { useActionFeedback } from "@/components/use-action-feedback";

/** Restore and delete-forever buttons of one trash row. */
export function TrashRowActions({
  slug,
  kind,
  id,
  title,
}: {
  slug: string;
  kind: string;
  id: string;
  title: string;
}) {
  const [state, formAction, pending] = useActionFeedback(restoreTrashAction.bind(null, slug));
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1">
      <form action={formAction}>
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="id" value={id} />
        <SubmitButton variant="outline" size="sm" pending={pending} aria-label={`${title} geri yükle`}>
          <Undo2 aria-hidden />
          Geri yükle
        </SubmitButton>
      </form>
      <ConfirmAction
        action={purgeTrashAction.bind(null, slug)}
        fields={{ kind, id }}
        title="Kalıcı olarak silinsin mi?"
        description={`“${title}” kalıcı olarak silinir. Bu işlem geri alınamaz.`}
        confirmLabel="Kalıcı olarak sil"
        trigger={<Trash2 aria-hidden />}
        triggerLabel={`${title} kalıcı olarak sil`}
        triggerSize="icon-sm"
      />
      {!state.ok && state.error ? <FormError message={state.error} className="basis-full" /> : null}
    </div>
  );
}
