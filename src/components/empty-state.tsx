import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Calm placeholder for lists with no items yet. `compact` is for empty
 * panels inside a card (overview sections): one quiet row, no frame.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    return (
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-3 px-2 py-3", className)}>
        {Icon ? (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border">
            <Icon className="size-4" aria-hidden />
          </div>
        ) : null}
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-medium">{title}</p>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong/40 bg-card/60 px-6 py-12 text-center",
        className,
      )}
    >
      {Icon ? (
        <div className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground ring-1 ring-border">
          <Icon className="size-5" aria-hidden />
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
