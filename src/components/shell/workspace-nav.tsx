"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_ITEMS, workspaceHref } from "@/components/shell/nav-items";
import { cn } from "@/lib/utils";

function useActiveSegment(slug: string) {
  const pathname = usePathname() ?? "";
  const base = `/w/${slug}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  return rest.split("/").filter(Boolean)[0] ?? "";
}

/** Vertical nav for the desktop sidebar. */
export function SidebarNav({ slug }: { slug: string }) {
  const active = useActiveSegment(slug);
  return (
    <nav aria-label="Çalışma alanı" className="grid gap-0.5">
      {NAV_ITEMS.map(({ segment, label, icon: Icon }) => {
        const isActive = active === segment;
        return (
          <Link
            key={segment || "overview"}
            href={workspaceHref(slug, segment)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "group/nav relative flex h-9 items-center pointer-coarse:h-10 gap-2.5 rounded-lg px-2.5 text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
              isActive &&
                "bg-card font-medium text-sidebar-accent-foreground shadow-xs ring-1 ring-sidebar-border hover:bg-card",
            )}
          >
            <Icon
              className={cn("size-4 shrink-0 text-muted-foreground", isActive && "text-primary")}
              aria-hidden
            />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Horizontally scrollable tab strip for small screens. */
export function MobileNav({ slug }: { slug: string }) {
  const active = useActiveSegment(slug);
  return (
    <nav
      aria-label="Çalışma alanı"
      className="-mx-4 flex overflow-x-auto px-2 [scrollbar-width:none] md:hidden"
    >
      {NAV_ITEMS.map(({ segment, label, icon: Icon }) => {
        const isActive = active === segment;
        return (
          <Link
            key={segment || "overview"}
            href={workspaceHref(slug, segment)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative flex h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50",
              // Active tab: an accent underline sitting on the header's bottom border.
              isActive &&
                "font-medium text-foreground after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary",
            )}
          >
            <Icon className={cn("size-4", isActive && "text-primary")} aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
