import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, Plus, Users } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { ROLE_LABELS } from "@/lib/roles";
import { requireUser } from "@/lib/tenant";
import { listUserWorkspaces } from "@/server/workspaces";

export const metadata: Metadata = { title: "Çalışma alanlarım" };

export default async function AppHome() {
  const user = await requireUser();
  const workspaces = await listUserWorkspaces(user.id);
  if (workspaces.length === 0) redirect("/onboarding");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Çalışma alanlarım"
        description="Üyesi olduğunuz çalışma alanları."
        actions={
          <Link href="/onboarding" className={buttonVariants()}>
            <Plus aria-hidden />
            Yeni çalışma alanı
          </Link>
        }
      />
      <ul className="grid gap-3 sm:grid-cols-2">
        {workspaces.map((w) => (
          <li key={w.id}>
            <Link
              href={`/w/${w.slug}`}
              className="group flex items-center gap-4 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-base font-semibold text-primary-text">
                {w.name.slice(0, 1).toLocaleUpperCase("tr")}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{w.name}</span>
                <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <Users className="size-3.5" aria-hidden />
                  {w.memberCount} üye
                  <Badge variant="secondary">{ROLE_LABELS[w.role]}</Badge>
                </span>
              </span>
              <ChevronRight
                className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
