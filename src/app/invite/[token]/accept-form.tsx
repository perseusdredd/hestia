"use client";

import { useActionState } from "react";

import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import type { ActionState } from "@/lib/action-state";

import { acceptInvitationAction } from "./actions";

export function AcceptInviteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(acceptInvitationAction, {});
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="token" value={token} />
      <FormError message={state.error} />
      <SubmitButton pending={pending} pendingText="Katılınıyor" size="lg" className="w-full">
        Daveti kabul et
      </SubmitButton>
    </form>
  );
}
