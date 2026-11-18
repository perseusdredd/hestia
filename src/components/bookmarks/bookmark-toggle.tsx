"use client";

import { useActionState, useEffect } from "react";
import { Bookmark, BookmarkCheck } from "lucide-react";
import { toast } from "sonner";

import { toggleBookmarkAction } from "@/components/bookmarks/actions";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/action-state";

/** "Yer imi ekle" / "Yer imini kaldır" for one post, to-do, document or event. */
export function BookmarkToggle({
  slug,
  subject,
  bookmarked,
}: {
  slug: string;
  subject: { type: "post" | "todo" | "document" | "event"; id: string };
  bookmarked: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    toggleBookmarkAction.bind(null, slug, subject.type, subject.id),
    {},
  );
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
    else if (state.error) toast.error(state.error);
  }, [state]);

  return (
    <form action={action}>
      <input type="hidden" name="bookmarked" value={bookmarked ? "false" : "true"} />
      <Button type="submit" variant="outline" size="sm" disabled={pending} aria-busy={pending}>
        {bookmarked ? <BookmarkCheck aria-hidden /> : <Bookmark aria-hidden />}
        {bookmarked ? "Yer imini kaldır" : "Yer imi ekle"}
      </Button>
    </form>
  );
}
