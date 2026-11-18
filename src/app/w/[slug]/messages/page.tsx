import type { Metadata } from "next";
import Link from "next/link";
import { MessageSquare, Plus } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PostList } from "@/components/messages/post-list";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { requireWorkspace } from "@/lib/tenant";
import { CategoryFilter } from "@/components/messages/category-filter";
import { listCategories } from "@/server/message-categories";
import { listPosts } from "@/server/messages";

export const metadata: Metadata = { title: "Mesajlar" };

export default async function MessagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ kat?: string | string[]; taslak?: string | string[] }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const { ctx } = await requireWorkspace(slug);
  const categories = await listCategories(ctx);
  const kat = typeof sp.kat === "string" ? sp.kat : "";
  const categoryId = categories.some((c) => c.id === kat) ? kat : null;
  const draftsOnly = sp.taslak === "1";
  const { items, hasMore, nextCursor } = await listPosts(ctx, { categoryId, draftsOnly });
  const filtered = Boolean(categoryId) || draftsOnly;

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
      <CategoryFilter slug={slug} categories={categories} activeCategoryId={categoryId} draftsOnly={draftsOnly} />
      {items.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title={filtered ? "Bu filtreyle mesaj yok" : "Henüz mesaj yok"}
          description={
            filtered
              ? "Başka bir kategori seçin ya da yeni bir mesaj yazın."
              : "İlk mesajı yazarak ekibinizle konuşmayı başlatın."
          }
          action={newButton}
        />
      ) : (
        <PostList
          slug={slug}
          initialItems={items}
          initialHasMore={hasMore}
          initialCursor={nextCursor}
          categoryId={categoryId}
          draftsOnly={draftsOnly}
        />
      )}
    </div>
  );
}
