import type { Metadata } from "next";
import Link from "next/link";
import { Pencil, Trash2 } from "lucide-react";

import { BookmarkToggle } from "@/components/bookmarks/bookmark-toggle";
import { CommentThread } from "@/components/comments/comment-thread";
import { ConfirmAction } from "@/components/confirm-action";
import { FilesBreadcrumbs } from "@/components/files/breadcrumbs";
import { EmptyState } from "@/components/empty-state";
import { InternalBadge } from "@/components/internal-toggle";
import { Markdown } from "@/components/markdown";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDateTime, formatRelative } from "@/lib/format";
import { canModify } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { isBookmarked } from "@/server/bookmarks";
import { getDocument } from "@/server/files";
import { ReactionBar } from "@/components/reactions/reaction-bar";
import { listReactions, REACTION_EMOJIS } from "@/server/reactions";

import { deleteDocumentAction } from "../../actions";
import { orNotFound } from "../../load";
import { documentHref } from "../../paths";

type Params = Promise<{ slug: string; docId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, docId } = await params;
  const { ctx } = await requireWorkspace(slug);
  const { document } = await orNotFound(() => getDocument(ctx, docId));
  return { title: document.title };
}

export default async function DocumentPage({ params }: { params: Params }) {
  const { slug, docId } = await params;
  const { ctx } = await requireWorkspace(slug);
  const { document, breadcrumbs } = await orNotFound(() => getDocument(ctx, docId));
  const bookmarked = await isBookmarked(ctx, { type: "document", id: document.id });
  const reactions = await listReactions(ctx, "document", [document.id]);
  const editable = canModify(ctx, document.authorId);
  const edited = document.updatedAt.getTime() - document.createdAt.getTime() > 1000;

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          document.internal ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              {document.title}
              <InternalBadge />
            </span>
          ) : (
            document.title
          )
        }
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <UserAvatar user={document.author} size="sm" />
            <span>{displayName(document.author)}</span>
            <span aria-hidden>·</span>
            <time dateTime={document.createdAt.toISOString()} title={formatDateTime(document.createdAt)}>
              {formatDateTime(document.createdAt)}
            </time>
            {edited ? (
              <span title={formatDateTime(document.updatedAt)}>
                · {formatRelative(document.updatedAt)} düzenlendi
              </span>
            ) : null}
          </span>
        }
        actions={
          editable ? (
            <>
              <Link
                href={`${documentHref(slug, document.id)}/edit`}
                className={buttonVariants({ variant: "outline" })}
              >
                <Pencil aria-hidden />
                Düzenle
              </Link>
              <ConfirmAction
                action={deleteDocumentAction.bind(null, slug)}
                fields={{ id: document.id }}
                title="Doküman silinsin mi?"
                description="Doküman çöp kutusuna taşınır; 30 gün içinde geri yüklenebilir."
                confirmLabel="Sil"
                triggerVariant="outline"
                triggerSize="default"
                trigger={
                  <>
                    <Trash2 aria-hidden />
                    Sil
                  </>
                }
              />
            </>
          ) : null
        }
      />
      <FilesBreadcrumbs slug={slug} crumbs={breadcrumbs} linkLast />
      {document.content.trim() ? (
        <Card>
          <CardContent>
            <Markdown text={document.content} />
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          title="Bu doküman boş"
          description={editable ? "Düzenle düğmesiyle içerik ekleyebilirsiniz." : undefined}
        />
      )}
      <ReactionBar
        slug={slug}
        subject={{ type: "document", id: document.id }}
        reactions={reactions[document.id] ?? []}
        allowed={REACTION_EMOJIS}
      />
      <BookmarkToggle slug={slug} subject={{ type: "document", id: document.id }} bookmarked={bookmarked} />
      <CommentThread slug={slug} ctx={ctx} subject={{ type: "document", id: document.id }} />
    </div>
  );
}
