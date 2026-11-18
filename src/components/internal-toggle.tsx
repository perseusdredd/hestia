import { Lock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * "Yalnızca ekip" checkbox for the create / edit forms of messages, to-do
 * lists, folders, documents and events. Submits `internal=on` when checked;
 * render it only for non-guests (the service ignores it for guests anyway).
 */
export function InternalToggle({
  id,
  defaultChecked = false,
  className,
}: {
  id: string;
  defaultChecked?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-0.5", className)}>
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <input id={id} type="checkbox" name="internal" defaultChecked={defaultChecked} className="size-4 accent-primary" />
        Yalnızca ekip
      </label>
      <p className="pl-6 text-meta text-muted-foreground">Misafir / müşteri rolündekiler bunu göremez.</p>
    </div>
  );
}

/** Badge shown next to the title of team-only content. */
export function InternalBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={className}>
      <Lock aria-hidden />
      Ekip içi
    </Badge>
  );
}
