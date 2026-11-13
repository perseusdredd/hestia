"use client";

import { CheckCheck } from "lucide-react";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";

import { markAllReadAction, openNotificationAction } from "@/app/w/[slug]/notifications/actions";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { UserAvatar } from "@/components/user-avatar";
import type { ActionState } from "@/lib/action-state";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

import { notificationIcon, type NotificationView } from "./notification-view";

export function MarkAllReadForm({ slug, disabled }: { slug: string; disabled?: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    markAllReadAction.bind(null, slug),
    {},
  );
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);
  return (
    <form action={action} className="grid gap-2">
      <SubmitButton variant="outline" pending={pending} pendingText="İşaretleniyor" disabled={disabled}>
        <CheckCheck aria-hidden />
        Tümünü okundu işaretle
      </SubmitButton>
      {!state.ok ? <FormError message={state.error} /> : null}
    </form>
  );
}

/** One notification. Submitting marks it read and opens its page (works without JS). */
export function NotificationRow({ slug, n }: { slug: string; n: NotificationView }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    openNotificationAction.bind(null, slug),
    {},
  );
  const Icon = notificationIcon(n.type);
  return (
    <li>
      <form action={action}>
        <input type="hidden" name="id" value={n.id} />
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className={cn(
            "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60",
            !n.read && "bg-primary/5",
          )}
        >
          <span className="relative mt-0.5 shrink-0">
            {n.actor ? (
              <UserAvatar user={n.actor} size="sm" />
            ) : (
              <span className="flex size-6 rounded-full bg-muted" />
            )}
            <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-background ring-1 ring-border">
              <Icon className="size-2.5 text-muted-foreground" aria-hidden />
            </span>
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className={cn("text-sm break-words", !n.read && "font-medium")}>{n.title}</span>
            {n.body ? (
              <span className="line-clamp-2 text-sm break-words text-muted-foreground">{n.body}</span>
            ) : null}
            <time
              dateTime={n.createdAt}
              title={formatDateTime(n.createdAt)}
              className="text-xs text-muted-foreground"
            >
              {formatRelative(n.createdAt)}
            </time>
          </span>
          {!n.read ? (
            <span className="mt-1.5 flex shrink-0 items-center gap-1.5 text-xs text-primary-text">
              <span className="size-2 rounded-full bg-primary" aria-hidden />
              <span className="sr-only sm:not-sr-only">Yeni</span>
            </span>
          ) : null}
        </button>
      </form>
      {state.error ? <FormError message={state.error} className="mx-3 mb-2" /> : null}
    </li>
  );
}
