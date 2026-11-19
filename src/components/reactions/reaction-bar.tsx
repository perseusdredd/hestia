"use client";

import { useActionState, useEffect } from "react";
import { SmilePlus } from "lucide-react";
import { toast } from "sonner";

import { toggleReactionAction } from "@/components/reactions/actions";
import type { ActionState } from "@/lib/action-state";
import { cn } from "@/lib/utils";
import type { ReactionSubjectType } from "@/server/reactions";

export type ReactionView = { emoji: string; count: number; mine: boolean };

/**
 * Boosts of one post or comment: a chip per used emoji with its count (tap to
 * toggle your own) and a row of the allowed emojis to add a new one. The
 * counts come from the server page, so they follow the revalidation.
 */
export function ReactionBar({
  slug,
  subject,
  reactions,
  allowed,
}: {
  slug: string;
  subject: { type: ReactionSubjectType; id: string };
  reactions: ReactionView[];
  allowed: readonly string[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    toggleReactionAction.bind(null, slug, subject.type, subject.id),
    {},
  );
  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state]);

  const used = new Set(reactions.map((r) => r.emoji));
  const unused = allowed.filter((e) => !used.has(e));

  return (
    <form action={action} className="flex flex-wrap items-center gap-1.5" aria-label="Tepkiler">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="submit"
          name="emoji"
          value={r.emoji}
          disabled={pending}
          aria-pressed={r.mine}
          aria-label={`${r.emoji} tepkisi, ${r.count} kişi${r.mine ? ", siz dahil" : ""}`}
          className={cn(
            "inline-flex min-h-8 items-center gap-1 rounded-full border px-2.5 text-sm transition-colors hover:bg-muted disabled:opacity-60",
            r.mine && "border-primary/50 bg-primary/10",
          )}
        >
          <span aria-hidden>{r.emoji}</span>
          <span className="text-xs tabular-nums">{r.count}</span>
        </button>
      ))}
      {unused.length > 0 ? (
        <details className="group relative">
          <summary
            className="inline-flex min-h-8 min-w-8 cursor-pointer list-none items-center justify-center rounded-full border px-2 text-muted-foreground hover:bg-muted [&::-webkit-details-marker]:hidden"
            aria-label="Tepki ekle"
          >
            <SmilePlus className="size-4" aria-hidden />
          </summary>
          <div className="absolute left-0 z-10 mt-1 flex gap-1 rounded-lg border bg-popover p-1 shadow-md">
            {unused.map((e) => (
              <button
                key={e}
                type="submit"
                name="emoji"
                value={e}
                disabled={pending}
                aria-label={`${e} ile tepki ver`}
                className="inline-flex size-10 items-center justify-center rounded-md text-lg hover:bg-muted disabled:opacity-60"
              >
                <span aria-hidden>{e}</span>
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </form>
  );
}
