import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";

import { VerifyEmailBanner } from "@/components/account/verify-email-banner";
import { Logo } from "@/components/logo";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { toNotificationView } from "@/components/notifications/notification-view";
import { ShellSearch } from "@/components/shell/shell-search";
import { UserMenu } from "@/components/shell/user-menu";
import { MobileNav, SidebarNav } from "@/components/shell/workspace-nav";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";
import { requireWorkspace } from "@/lib/tenant";
import { isVerifyBannerDismissed, VERIFY_BANNER_COOKIE } from "@/lib/verify-banner";
import { listNotifications, NOTIFICATION_BELL_ITEMS, unreadCount } from "@/server/notifications";
import { listUserWorkspaces } from "@/server/workspaces";
import { MAIN_ID } from "@/components/skip-link";

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  return { title: { default: workspace.name, template: `%s · ${workspace.name} · Hestia` } };
}

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Params;
}) {
  const { slug } = await params;
  // NOTE: this guards rendering only. Every page, server action and route
  // handler below must call requireWorkspace(slug) itself.
  const { user, workspace, ctx } = await requireWorkspace(slug);
  const showVerifyBanner =
    !user.emailVerified &&
    !isVerifyBannerDismissed((await cookies()).get(VERIFY_BANNER_COOKIE)?.value, user.email);
  const [workspaces, unread, latest] = await Promise.all([
    listUserWorkspaces(user.id),
    unreadCount(ctx),
    listNotifications(ctx, { take: NOTIFICATION_BELL_ITEMS }),
  ]);
  const current = { id: workspace.id, name: workspace.name, slug: workspace.slug };

  return (
    <div className="flex min-h-dvh bg-background">
      {/* The aside stretches with the page (full-height background); its content stays pinned. */}
      <aside className="hidden w-60 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
        <div className="sticky top-0 flex h-dvh flex-col gap-5 p-3">
          <Link
            href="/app"
            className="flex h-10 items-center rounded-lg px-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label="Hestia, çalışma alanlarım"
          >
            <Logo />
          </Link>
          <div className="grid gap-1">
            <p className="px-2.5 text-meta font-medium">Çalışma alanı</p>
            <WorkspaceSwitcher
              current={current}
              workspaces={workspaces}
              className="h-10 w-full border-border bg-card hover:bg-accent"
            />
          </div>
          <SidebarNav slug={workspace.slug} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
          <div className="flex h-14 items-center gap-2 px-4 sm:px-6">
            {/* Hestia lives inside the Perseus assistant; this goes back to it. */}
            <a
              href={process.env.ASSISTANT_URL || "https://crm.numanbayram.com"}
              className="flex h-9 shrink-0 items-center gap-1 rounded-lg pr-2 pl-1 text-sm font-medium text-primary-text outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Asistana dön"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-5" aria-hidden>
                <path d="m15 6-6 6 6 6" />
              </svg>
              <span className="hidden sm:inline">Asistan</span>
            </a>
            <WorkspaceSwitcher
              current={current}
              workspaces={workspaces}
              className="max-w-[60vw] md:hidden"
            />
            <ShellSearch
              slug={workspace.slug}
              id="shell-search-desktop"
              shortcut
              className="hidden w-full max-w-sm md:block"
            />
            <div className="ml-auto flex items-center gap-1">
              <NotificationBell
                key={workspace.id}
                slug={workspace.slug}
                initial={{ unread, items: latest.items.map(toNotificationView) }}
              />
              <UserMenu user={user} />
            </div>
          </div>
          <div className="grid gap-2 px-4 pt-0.5 md:hidden">
            <ShellSearch slug={workspace.slug} id="shell-search-mobile" />
            <MobileNav slug={workspace.slug} />
          </div>
        </header>
        <main id={MAIN_ID} tabIndex={-1} className="outline-none mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {showVerifyBanner ? <VerifyEmailBanner email={user.email} /> : null}
          {children}
        </main>
      </div>
    </div>
  );
}
