"use client";

import { BellOff } from "lucide-react";
import { useRef } from "react";

import { type DeferredMenuProps, useFocusOnMount } from "@/components/deferred-menu";
import { BellTriggerContent, bellLabel, type BellMenuProps } from "@/components/notifications/notification-bell";
import { DropdownMenuLink } from "@/components/shell/menu-link-item";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

import { formatUnread, notificationIcon } from "./notification-view";

/** The bell's real menu; loaded after hydration by NotificationBell (see DeferredMenu). */
export function NotificationMenu({
  slug,
  summary,
  pending,
  onRefresh,
  onOpenItem,
  defaultOpen,
  autoFocus,
}: BellMenuProps & DeferredMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  useFocusOnMount(trigger, autoFocus);
  const { unread, items } = summary;
  return (
    <DropdownMenu
      defaultOpen={defaultOpen}
      onOpenChange={(isOpen) => {
        if (isOpen) onRefresh();
      }}
    >
      <DropdownMenuTrigger
        ref={trigger}
        render={<Button variant="ghost" size="icon" className="relative rounded-full" aria-label={bellLabel(unread)} />}
      >
        <BellTriggerContent unread={unread} pending={pending} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center justify-between py-1.5">
            <span className="text-sm font-medium text-foreground">Bildirimler</span>
            {unread ? <span className="text-xs">{formatUnread(unread)} okunmamış</span> : null}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-sm text-muted-foreground">
            <BellOff className="size-5" aria-hidden />
            Henüz bildiriminiz yok.
          </div>
        ) : (
          items.map((n) => {
            const Icon = notificationIcon(n.type);
            return (
              <DropdownMenuItem
                key={n.id}
                disabled={pending}
                onClick={() => onOpenItem(n)}
                className="items-start gap-2.5 py-2"
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
                    !n.read && "bg-primary-soft text-primary-text",
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className={cn("line-clamp-2 text-sm", !n.read && "font-medium")}>{n.title}</span>
                  {n.body ? (
                    <span className="truncate text-xs text-muted-foreground">{n.body}</span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">{formatRelative(n.createdAt)}</span>
                </span>
                {!n.read ? (
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label="Okunmadı" />
                ) : null}
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLink href={`/w/${slug}/notifications`} className="justify-center font-medium">
          Tüm bildirimleri gör
        </DropdownMenuLink>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
