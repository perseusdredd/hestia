import type { Metadata } from "next";
import Link from "next/link";
import { Activity, SearchX } from "lucide-react";

import { ActivityFeed } from "@/components/activity/activity-feed";
import { ActivityFilters } from "@/components/activity/activity-filters";
import { ACTIVITY_GROUP_LABELS, activityHref, toActivityView } from "@/components/activity/activity-view";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { addDaysToKey, istanbulDayKey } from "@/lib/istanbul-time";
import { requireWorkspace } from "@/lib/tenant";
import { ACTIVITY_GROUP_KEYS, ACTIVITY_GROUPS, isActivityGroup, listActivity } from "@/server/activity";
import { listMemberUsers } from "@/server/workspaces";

export const metadata: Metadata = { title: "Hareket akışı" };

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ type?: string | string[]; actor?: string | string[] }>;
}) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const sp = await searchParams;

  const rawGroup = first(sp.type);
  const group = isActivityGroup(rawGroup) ? rawGroup : null;
  const members = await listMemberUsers(ctx);
  // Only current members can be picked; anything else is ignored.
  const rawActor = first(sp.actor).slice(0, 64);
  const actorId = members.some((m) => m.id === rawActor) ? rawActor : null;

  const page = await listActivity(ctx, {
    types: group ? [...ACTIVITY_GROUPS[group]] : null,
    actorId,
  });
  const items = page.items.map(toActivityView);
  const todayKey = istanbulDayKey(new Date());
  const filtered = Boolean(group || actorId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Hareket akışı"
        description="Çalışma alanında kimin neyi ne zaman yaptığını görün."
      />

      <ActivityFilters
        key={`${group ?? ""}:${actorId ?? ""}`}
        slug={slug}
        groups={ACTIVITY_GROUP_KEYS.map((key) => ({ key, label: ACTIVITY_GROUP_LABELS[key] }))}
        group={group}
        actorId={actorId}
        members={members}
      />

      {items.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={SearchX}
            title="Bu filtreye uyan hareket yok"
            description="Başka bir tür ya da üye seçmeyi deneyin."
            action={
              <Link href={activityHref(slug, null, null)} className={buttonVariants({ variant: "outline" })}>
                Filtreleri temizle
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={Activity}
            title="Henüz hareket yok"
            description="Mesaj paylaşıldığında, görev eklendiğinde, dosya yüklendiğinde ya da yeni biri katıldığında burada görünecek."
          />
        )
      ) : (
        <ActivityFeed
          key={`${group ?? ""}:${actorId ?? ""}`}
          slug={slug}
          initialItems={items}
          initialCursor={page.nextCursor}
          group={group ?? ""}
          actorId={actorId ?? ""}
          todayKey={todayKey}
          yesterdayKey={addDaysToKey(todayKey, -1)}
        />
      )}
    </div>
  );
}
