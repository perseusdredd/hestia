import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pin } from "lucide-react";

import { CommentThread } from "@/components/comments/comment-thread";
import { SubscribeToggle } from "@/components/subscriptions/subscribe-toggle";
import { PostControls } from "@/components/messages/post-controls";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDateTime, formatRelative } from "@/lib/format";
import { canModify, hasRole } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { isServiceError } from "@/server/errors";
import { listMentionCandidates, mentionNames } from "@/server/comments";
import { getPostHeader } from "@/server/messages";
import { isSubscribed, countSubscribers } from "@/server/subscriptions";

export const metadata: Metadata = { title: "Mesaj" };

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string; postId: string }>;
}) {
  const { slug, postId } = await params;
  const { ctx } = await requireWorkspace(slug);

  let post;
  try {
    post = await getPostHeader(ctx, postId);
  } catch (e) {
    // A malformed id (e.g. over 64 chars) is just a page that does not exist.
    if (isServiceError(e) && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  }

  const subject = { type: "post" as const, id: post.id };
  const [members, names, subscribed, subscribers] = await Promise.all([
    listMentionCandidates(ctx),
    mentionNames(ctx, [post.body]),
    isSubscribed(ctx, subject),
    countSubscribers(ctx, subject),
  ]);
  const edited = post.updatedAt.getTime() - post.createdAt.getTime() > 1000;

  return (
    <div className="space-y-8">
      <div>
        <Link href={`/w/${slug}/messages`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeft aria-hidden />
          Mesajlar
        </Link>
      </div>

      <article className="max-w-3xl space-y-5">
        <header className="space-y-3">
          <div className="flex items-start gap-2">
            <h1 className="min-w-0 flex-1 text-page-title break-words">
              {post.title}
            </h1>
            {post.pinned ? (
              <Badge variant="secondary" className="mt-1 shrink-0">
                <Pin className="size-3" aria-hidden />
                Sabit
              </Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-2.5 text-sm">
            <UserAvatar user={post.author} />
            <div className="min-w-0">
              <p className="truncate font-medium">{displayName(post.author)}</p>
              <p className="text-xs text-muted-foreground">
                <time dateTime={post.createdAt.toISOString()}>{formatDateTime(post.createdAt)}</time>
                {edited ? ` (düzenlendi ${formatRelative(post.updatedAt)})` : null}
              </p>
            </div>
          </div>
        </header>

        <PostControls
          slug={slug}
          post={{ id: post.id, title: post.title, body: post.body, pinned: post.pinned }}
          canModify={canModify(ctx, post.authorId)}
          canPin={hasRole(ctx.role, "ADMIN")}
          members={members}
        >
          <Markdown text={post.body} className="text-base" mentions={names} />
        </PostControls>

        <SubscribeToggle slug={slug} subject={subject} subscribed={subscribed} count={subscribers} />
      </article>

      <CommentThread slug={slug} ctx={ctx} subject={{ type: "post", id: post.id }} />
    </div>
  );
}
