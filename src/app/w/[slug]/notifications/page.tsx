import type { Metadata } from "next";
import Link from "next/link";
import { BellOff, CheckCheck } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { MarkAllReadForm, NotificationRow } from "@/components/notifications/notification-list";
import { toNotificationView } from "@/components/notifications/notification-view";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { requireWorkspace } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { isServiceError } from "@/server/errors";
import { listNotifications, unreadCount } from "@/server/notifications";

export const metadata: Metadata = { title: "Bildirimler" };

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ filter?: string | string[]; cursor?: string | string[] }>;
}) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const sp = await searchParams;
  const unreadOnly = first(sp.filter) === "unread";
  const cursor = first(sp.cursor).slice(0, 256) || null;

  const load = (c: string | null) => listNotifications(ctx, { unreadOnly, cursor: c });
  const [unread, page] = await Promise.all([
    unreadCount(ctx),
    // A stale or tampered cursor falls back to the first page instead of an error page.
    load(cursor).catch((e: unknown) => {
      if (isServiceError(e) && e.code === "VALIDATION") return load(null);
      throw e;
    }),
  ]);
  const items = page.items.map(toNotificationView);
  const base = `/w/${slug}/notifications`;
  const firstPage = unreadOnly ? `${base}?filter=unread` : base;
  const tabs = [
    { href: base, label: "Tümü", active: !unreadOnly },
    {
      href: `${base}?filter=unread`,
      label: `Okunmamış${unread ? ` (${unread})` : ""}`,
      active: unreadOnly,
    },
  ];
  const nextHref =
    page.hasMore && page.nextCursor
      ? `${base}?${unreadOnly ? "filter=unread&" : ""}cursor=${encodeURIComponent(page.nextCursor)}`
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bildirimler"
        description="Size atanan görevler, yeni mesajlar, yorumlar, etkinlikler ve yeni üyeler."
        actions={<MarkAllReadForm slug={slug} disabled={unread === 0} />}
      />

      <nav aria-label="Bildirim filtresi" className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={t.active ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
              t.active && "border-primary/40 bg-primary-soft font-medium text-primary-text hover:text-primary-text",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        cursor ? (
          <EmptyState
            icon={BellOff}
            title="Daha eski bildirim yok"
            action={
              <Link href={firstPage} className={buttonVariants({ variant: "outline" })}>
                En yenilere dön
              </Link>
            }
          />
        ) : unreadOnly ? (
          <EmptyState
            icon={CheckCheck}
            title="Okunmamış bildiriminiz yok"
            description="Hepsini okudunuz. Yeni bir şey olduğunda burada görünecek."
            action={
              <Link href={base} className={buttonVariants({ variant: "outline" })}>
                Tüm bildirimleri gör
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={BellOff}
            title="Henüz bildiriminiz yok"
            description="Size bir görev atandığında ya da yeni bir mesaj, yorum veya etkinlik eklendiğinde burada göreceksiniz."
          />
        )
      ) : (
        <div className="space-y-4">
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {items.map((n) => (
              <NotificationRow key={n.id} slug={slug} n={n} />
            ))}
          </ul>
          {cursor || nextHref ? (
            <div className="flex flex-wrap justify-center gap-2">
              {cursor ? (
                <Link href={firstPage} className={buttonVariants({ variant: "ghost" })}>
                  En yenilere dön
                </Link>
              ) : null}
              {nextHref ? (
                <Link href={nextHref} className={buttonVariants({ variant: "outline" })}>
                  Daha eski bildirimler
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
