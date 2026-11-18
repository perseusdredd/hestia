"use client";

import { useActionState, useEffect } from "react";
import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";

import { toggleSubscriptionAction } from "@/components/subscriptions/actions";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/action-state";

/**
 * "Abone ol" / "Abonelikten çık" for one post, to-do or event, with the
 * subscriber count. `subscribed` comes from the server page, so it follows the
 * revalidation after each toggle.
 */
export function SubscribeToggle({
  slug,
  subject,
  subscribed,
  count,
}: {
  slug: string;
  subject: { type: "post" | "todo" | "event"; id: string };
  subscribed: boolean;
  count: number;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    toggleSubscriptionAction.bind(null, slug, subject.type, subject.id),
    {},
  );
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
    else if (state.error) toast.error(state.error);
  }, [state]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={action}>
        <input type="hidden" name="subscribed" value={subscribed ? "false" : "true"} />
        <Button type="submit" variant="outline" size="sm" disabled={pending} aria-busy={pending}>
          {subscribed ? <BellOff aria-hidden /> : <Bell aria-hidden />}
          {subscribed ? "Abonelikten çık" : "Abone ol"}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        {count === 0 ? "Henüz abone yok" : `${count} abone`}
        {subscribed ? " (siz dahil)" : ""} · yorumlardan haberdar edilir
      </p>
    </div>
  );
}
