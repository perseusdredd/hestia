import { MessageSquare } from "lucide-react";

import { CommentForm } from "@/components/comments/comment-form";
import { CommentItem } from "@/components/comments/comment-item";
import { Markdown } from "@/components/markdown";
import { canModify } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import {
  COMMENTS_SHOWN_MAX,
  countComments,
  listComments,
  listMentionCandidates,
  mentionNames,
  type CommentSubject,
} from "@/server/comments";

/**
 * Comments on one subject (post, to-do, document or event) with the form to
 * add one. Server component: loads the comments, the mention names (from the
 * DB, current members only) and the @ suggestions for ctx's workspace.
 */
export async function CommentThread({
  slug,
  ctx,
  subject,
  className,
}: {
  slug: string;
  ctx: TenantContext;
  subject: CommentSubject;
  className?: string;
}) {
  const [comments, members] = await Promise.all([listComments(ctx, subject), listMentionCandidates(ctx)]);
  // Only a capped thread needs the real total.
  const [names, total] = await Promise.all([
    mentionNames(
      ctx,
      comments.map((c) => c.body),
    ),
    comments.length < COMMENTS_SHOWN_MAX
      ? comments.length
      : countComments(ctx, subject.type, [subject.id]).then((r) => r[subject.id] ?? comments.length),
  ]);
  const hidden = total - comments.length;
  const headingId = `comments-heading-${subject.type}`;

  return (
    <section className={className ?? "max-w-3xl space-y-5 border-t pt-6"} aria-labelledby={headingId}>
      <h2 id={headingId} className="flex items-center gap-2 font-medium">
        <MessageSquare className="size-4" aria-hidden />
        Yorumlar ({total})
      </h2>
      {hidden > 0 ? (
        <p className="text-sm text-muted-foreground">
          Son {comments.length} yorum gösteriliyor; daha eski {hidden} yorum gizli.
        </p>
      ) : null}
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">Henüz yorum yok. İlk yorumu siz yazın.</p>
      ) : (
        <ul className="grid gap-5">
          {comments.map((c) => (
            <CommentItem
              key={c.id}
              slug={slug}
              canModify={canModify(ctx, c.authorId)}
              members={members}
              comment={{
                id: c.id,
                body: c.body,
                createdAt: c.createdAt.toISOString(),
                edited: c.updatedAt.getTime() - c.createdAt.getTime() > 1000,
                author: { name: c.author.name, email: c.author.email, image: c.author.image },
              }}
            >
              <Markdown text={c.body} mentions={names} />
            </CommentItem>
          ))}
        </ul>
      )}
      <CommentForm slug={slug} subject={{ type: subject.type, id: subject.id }} members={members} />
    </section>
  );
}
