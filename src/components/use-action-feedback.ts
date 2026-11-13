"use client";

import { useActionState, useRef } from "react";
import { toast } from "sonner";

import type { ActionState } from "@/lib/action-state";

type Action<T> = (state: ActionState<T>, formData: FormData) => Promise<ActionState<T>>;

/**
 * useActionState that toasts the success message and runs `onSuccess` from
 * inside the action, right after the server answers.
 *
 * Doing this in a useEffect on `state` is unreliable for row-level actions
 * (delete, move to another list/folder): the server re-render that delivers
 * the result usually unmounts the row, so the effect never runs and the
 * success toast is lost.
 */
export function useActionFeedback<T = unknown>(
  action: Action<T>,
  {
    onSuccess,
    successMessage,
  }: { onSuccess?: (state: ActionState<T>) => void; successMessage?: string } = {},
) {
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const messageRef = useRef(successMessage);
  messageRef.current = successMessage;

  return useActionState<ActionState<T>, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result.ok) {
      const message = messageRef.current ?? result.message;
      if (message) toast.success(message);
      onSuccessRef.current?.(result);
    }
    return result;
  }, {});
}
