"use client";

import { Bell, Loader2 } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { openNotificationAction } from "@/app/w/[slug]/notifications/actions";
import { DeferredMenu } from "@/components/deferred-menu";
import { Button } from "@/components/ui/button";

import { formatUnread, type NotificationView } from "./notification-view";

type Summary = { unread: number; items: NotificationView[] };

export type BellMenuProps = {
  slug: string;
  summary: Summary;
  pending: boolean;
  onRefresh: () => void;
  onOpenItem: (n: NotificationView) => void;
};

const loadMenu = () => import("@/components/notifications/notification-menu").then((m) => m.NotificationMenu);

export const bellLabel = (unread: number) =>
  unread ? `Bildirimler, ${formatUnread(unread)} okunmamış` : "Bildirimler";

export function BellTriggerContent({ unread, pending }: { unread: number; pending: boolean }) {
  return (
    <>
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Bell aria-hidden />}
      {unread ? (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground tabular-nums ring-2 ring-background"
        >
          {formatUnread(unread)}
        </span>
      ) : null}
    </>
  );
}

/**
 * Bell with the unread count and the latest notifications. The first render
 * uses server data from the layout; it refetches on every navigation and when
 * opened (no websocket). The menu itself loads after hydration (DeferredMenu).
 */
export function NotificationBell({ slug, initial }: { slug: string; initial: Summary }) {
  // Fetched data is tied to the server snapshot it refreshed; a newer server
  // render of the layout (e.g. after "mark all read") wins automatically.
  const [fetched, setFetched] = useState<{ base: Summary; data: Summary } | null>(null);
  const summary = fetched && fetched.base === initial ? fetched.data : initial;
  const [pending, startTransition] = useTransition();
  const pathname = usePathname();
  const firstRender = useRef(true);

  // Only the most recently started refresh may write: an older response that
  // resolves later would otherwise overwrite newer data.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++seq.current;
    try {
      const res = await fetch(`/api/notifications/${encodeURIComponent(slug)}`, {
        cache: "no-store",
      });
      if (!res.ok || id !== seq.current) return;
      const body = (await res.json()) as {
        unread: number;
        items: (Omit<NotificationView, "read"> & { readAt: string | null })[];
      };
      if (id !== seq.current) return;
      setFetched({
        base: initial,
        data: {
          unread: body.unread,
          items: body.items.map(({ readAt, ...rest }) => ({ ...rest, read: readAt !== null })),
        },
      });
    } catch {
      // Offline or server hiccup: keep showing what we have.
    }
  }, [slug, initial]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    void refresh();
  }, [pathname, refresh]);

  function open(n: NotificationView) {
    const fd = new FormData();
    fd.set("id", n.id);
    startTransition(async () => {
      const state = await openNotificationAction(slug, {}, fd);
      // Only reached on failure: success redirects.
      if (state?.error) toast.error(state.error);
    });
  }

  const unread = summary.unread;
  const refreshNow = useCallback(() => void refresh(), [refresh]);

  return (
    <DeferredMenu
      load={loadMenu}
      props={{ slug, summary, pending, onRefresh: refreshNow, onOpenItem: open }}
      onRequestOpen={refreshNow}
      placeholder={(p) => (
        <Button {...p} variant="ghost" size="icon" className="relative rounded-full" aria-label={bellLabel(unread)}>
          <BellTriggerContent unread={unread} pending={pending} />
        </Button>
      )}
    />
  );
}
