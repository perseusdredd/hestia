"use client";

import { useState, useTransition } from "react";

import { loadMorePostsAction } from "@/app/w/[slug]/messages/actions";
import { FormError } from "@/components/form-error";
import { Button } from "@/components/ui/button";
import type { PostListItem } from "@/server/messages";

import { PostCard } from "./post-card";

/** First page comes from the server; "Daha fazla göster" appends further pages. */
export function PostList({
  slug,
  initialItems,
  initialHasMore,
  initialCursor,
}: {
  slug: string;
  initialItems: PostListItem[];
  initialHasMore: boolean;
  initialCursor: string | null;
}) {
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Reset when the server sends a fresh first page (after create/delete/pin).
  const [seen, setSeen] = useState(initialItems);
  if (seen !== initialItems) {
    setSeen(initialItems);
    setItems(initialItems);
    setHasMore(initialHasMore);
    setCursor(initialCursor);
  }

  function loadMore() {
    if (!cursor) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await loadMorePostsAction(slug, cursor);
        setItems((prev) => {
          const known = new Set(prev.map((p) => p.id));
          return [...prev, ...res.items.filter((p) => !known.has(p.id))];
        });
        setHasMore(res.hasMore);
        setCursor(res.nextCursor);
      } catch {
        setError("Mesajlar yüklenemedi. Lütfen tekrar deneyin.");
      }
    });
  }

  return (
    <div className="space-y-4">
      <ul className="grid gap-3">
        {items.map((post) => (
          <PostCard key={post.id} slug={slug} post={post} />
        ))}
      </ul>
      <FormError message={error} />
      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={pending} aria-busy={pending}>
            {pending ? "Yükleniyor" : "Daha fazla göster"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
