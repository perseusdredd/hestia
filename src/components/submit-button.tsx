"use client";

import { Loader2 } from "lucide-react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

type ButtonProps = React.ComponentProps<typeof Button>;

/**
 * Submit button that disables itself and shows a spinner while the enclosing
 * <form action={...}> is pending. Pass `pending` explicitly when you already
 * have it from useActionState.
 */
export function SubmitButton({
  children,
  pending: pendingProp,
  pendingText,
  disabled,
  ...props
}: ButtonProps & { pending?: boolean; pendingText?: React.ReactNode }) {
  const status = useFormStatus();
  const pending = pendingProp ?? status.pending;
  return (
    <Button type="submit" disabled={pending || disabled} aria-busy={pending} {...props}>
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {pending && pendingText ? pendingText : children}
    </Button>
  );
}
