import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pin } from "lucide-react";

import { CommentThread } from "@/components/comments/comment-thread";
import { BookmarkToggle } from "@/components/bookmarks/bookmark-toggle";
import { SubscribeToggle } from "@/components/subscriptions/subscribe-toggle";
import { PostControls } from "@/components/messages/post-controls";
import { Markdown } from "@/components/markdown";
import { ReactionBar } from "@/components/reactions/reaction-bar";
import { CategoryBadge } from "@/components/messages/category-badge";
import { InternalBadge } from "@/components/internal-toggle";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDateTime, formatRelative } from "@/lib/format";
import { toIstanbulInputValue } from "@/lib/istanbul-time";
import { canModify, hasRole, isGuest } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { isServiceError } from "@/server/errors";
import { listMentionCandidates, mentionNames } from "@/server/comments";
import { listCategories } from "@/server/message-categories";
import { getPostHeader } from "@/server/messages";
import { listReactions, REACTION_EMOJIS } from "@/server/reactions";
import { isBookmarked } from "@/server/bookmarks";
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
  const [members, categories, names, subscribed, subscribers, bookmarked, reactions] = await Promise.all([
    listMentionCandidates(ctx),
    listCategories(ctx),
    mentionNames(ctx, [post.body]),
    isSubscribed(ctx, subject),
    countSubscribers(ctx, subject),
    isBookmarked(ctx, subject),
    listReactions(ctx, "post", [post.id]),
  ]);
  const isDraft = post.publishedAt === null;
  const edited = !isDraft && post.updatedAt.getTime() - post.createdAt.getTime() > 1000;

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
            {isDraft ? (
              <Badge variant="outline" className="mt-1 shrink-0">
                {post.scheduledFor ? `Zamanlanmış: ${formatDateTime(post.scheduledFor)}` : "Taslak"}
              </Badge>
            ) : null}
            {post.internal ? <InternalBadge className="mt-1 shrink-0" /> : null}
            {post.category ? <CategoryBadge category={post.category} className="mt-1 shrink-0" /> : null}
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
          post={{
            id: post.id,
            title: post.title,
            body: post.body,
            pinned: post.pinned,
            categoryId: post.categoryId,
            isDraft,
            internal: post.internal,
            scheduledFor: post.scheduledFor ? toIstanbulInputValue(post.scheduledFor, true) : undefined,
          }}
          canSetInternal={!isGuest(ctx.role)}
          canModify={canModify(ctx, post.authorId)}
          canPin={hasRole(ctx.role, "ADMIN")}
          members={members}
          categories={categories}
        >
          <Markdown text={post.body} className="text-base" mentions={names} />
        </PostControls>

        <ReactionBar
          slug={slug}
          subject={{ type: "post", id: post.id }}
          reactions={reactions[post.id] ?? []}
          allowed={REACTION_EMOJIS}
        />

        <div className="flex flex-wrap items-center gap-3">
          <BookmarkToggle slug={slug} subject={subject} bookmarked={bookmarked} />
          <SubscribeToggle slug={slug} subject={subject} subscribed={subscribed} count={subscribers} />
        </div>
      </article>

      <CommentThread slug={slug} ctx={ctx} subject={{ type: "post", id: post.id }} />
    </div>
  );
}
