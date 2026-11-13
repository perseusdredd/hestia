import Link from "next/link";
import { MessageSquare, Pin } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatRelative } from "@/lib/format";
import type { PostListItem } from "@/server/messages";

/** One row in the message board list. Pure markup, usable from server or client components. */
export function PostCard({ slug, post }: { slug: string; post: PostListItem }) {
  return (
    <li>
      <Link
        href={`/w/${slug}/messages/${post.id}`}
        className="flex gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <UserAvatar user={post.author} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 truncate font-medium">{post.title}</h2>
            {post.pinned ? (
              <Badge variant="secondary" className="shrink-0">
                <Pin className="size-3" aria-hidden />
                Sabit
              </Badge>
            ) : null}
          </div>
          <p className="line-clamp-2 text-sm break-words text-muted-foreground">{post.excerpt}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
            <span>{displayName(post.author)}</span>
            <time dateTime={new Date(post.createdAt).toISOString()}>
              {formatRelative(post.createdAt)}
            </time>
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="size-3.5" aria-hidden />
              {post.commentCount} yorum
            </span>
          </div>
        </div>
      </Link>
    </li>
  );
}
