import type { Metadata } from "next";
import Link from "next/link";
import { MessageSquare, Plus } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PostList } from "@/components/messages/post-list";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { requireWorkspace } from "@/lib/tenant";
import { listPosts } from "@/server/messages";

export const metadata: Metadata = { title: "Mesajlar" };

export default async function MessagesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const { items, hasMore, nextCursor } = await listPosts(ctx);

  const newButton = (
    <Link href={`/w/${slug}/messages/new`} className={buttonVariants()}>
      <Plus aria-hidden />
      Yeni mesaj
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mesajlar"
        description="Ekibinizle duyuruları, güncellemeleri ve kararları paylaşın."
        actions={newButton}
      />
      {items.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="Henüz mesaj yok"
          description="İlk mesajı yazarak ekibinizle konuşmayı başlatın."
          action={newButton}
        />
      ) : (
        <PostList slug={slug} initialItems={items} initialHasMore={hasMore} initialCursor={nextCursor} />
      )}
    </div>
  );
}
