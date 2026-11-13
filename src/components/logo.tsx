import { cn } from "@/lib/utils";

/**
 * Hestia mark: a hearth arch with a flame inside. Drawn with currentColor so
 * it follows the surrounding text color; src/app/icon.svg is the same drawing
 * with fixed colors for the favicon.
 */
export function HearthMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path
        d="M4.75 19.5V11.25a7.25 7.25 0 0 1 14.5 0v8.25"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M12 19.25c-2.45 0-4-1.7-4-3.8 0-2.65 2.1-3.75 3.05-6.25 1.2 1.1 1.65 2.45 1.5 3.65.8-.55 1.4-1.4 1.7-2.4 1.25 1.2 1.75 2.9 1.75 4.5 0 2.5-1.55 4.3-4 4.3Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight", className)}>
      <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <HearthMark className="size-5" />
      </span>
      Hestia
    </span>
  );
}
