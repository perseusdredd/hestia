import { LogOut, Users } from "lucide-react";
import Link from "next/link";

import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import type { ActionState } from "@/lib/action-state";
import { ROLE_LABELS, type Role } from "@/lib/roles";

type Item = { id: string; name: string; slug: string; role: Role; memberCount: number };

export function AccountWorkspaceList({
  workspaces,
  leaveAction,
}: {
  workspaces: Item[];
  /** Returns the leave action bound to the given workspace slug. */
  leaveAction: (slug: string) => (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  if (workspaces.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Henüz bir çalışma alanınız yok"
        description="Yeni bir çalışma alanı oluşturun veya bir davet bağlantısıyla katılın."
        className="py-8"
      />
    );
  }
  return (
    <ul className="divide-y">
      {workspaces.map((w) => (
        <li key={w.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <Link href={`/w/${w.slug}`} className="block truncate text-sm font-medium hover:underline">
              {w.name}
            </Link>
            <p className="text-xs text-muted-foreground">{w.memberCount} üye</p>
          </div>
          <Badge variant={w.role === "OWNER" ? "default" : "secondary"}>{ROLE_LABELS[w.role]}</Badge>
          <ConfirmAction
            action={leaveAction(w.slug)}
            title={`${w.name} alanından ayrılmak istiyor musunuz?`}
            description="Bu çalışma alanının içeriklerine erişiminiz sona erer. Son sahipseniz önce başka bir üyeyi sahip yapmalısınız."
            confirmLabel="Ayrıl"
            triggerVariant="outline"
            triggerLabel={`${w.name} alanından ayrıl`}
            trigger={
              <>
                <LogOut aria-hidden />
                Ayrıl
              </>
            }
          />
        </li>
      ))}
    </ul>
  );
}
