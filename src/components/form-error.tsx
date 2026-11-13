import { CircleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

/** Form-level error banner (renders nothing when message is empty). */
export function FormError({ message, className }: { message?: string | null; className?: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive",
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

/** Inline error under a single field. Pass state.fieldErrors?.[name]. */
export function FieldError({ errors, id }: { errors?: string[] | null; id?: string }) {
  if (!errors?.length) return null;
  return (
    // role="alert": announced when it appears after a submit (the field itself carries aria-invalid).
    <p id={id} role="alert" className="text-xs text-destructive">
      {errors[0]}
    </p>
  );
}
