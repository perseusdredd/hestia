import Link from "next/link";
import { Bookmark } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { workspaceHref } from "@/components/shell/nav-items";
import { Badge } from "@/components/ui/badge";
import { formatRelative } from "@/lib/format";
import { requireWorkspace } from "@/lib/tenant";
import { listBookmarks, type BookmarkSubjectType } from "@/server/bookmarks";

export const metadata = { title: "Yer imlerim" };

const TYPE_LABEL: Record<BookmarkSubjectType, string> = {
  post: "Mesaj",
  todo: "Görev",
  document: "Doküman",
  event: "Etkinlik",
};

export default async function BookmarksPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const items = await listBookmarks(ctx);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Yer imlerim"
        description="Sonra dönmek için işaretlediğiniz mesaj, görev, doküman ve etkinlikler."
      />
      {items.length === 0 ? (
        <EmptyState
          icon={Bookmark}
          title="Henüz yer imi yok"
          description="Bir mesajın, görevin, dokümanın veya etkinliğin sayfasındaki Yer imi ekle düğmesini kullanın."
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card shadow-xs">
          {items.map((b) => (
            <li key={`${b.type}:${b.id}`}>
              <Link
                href={workspaceHref(slug, b.path)}
                className="flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <Badge variant="secondary">{TYPE_LABEL[b.type]}</Badge>
                <span className="min-w-0 flex-1 truncate font-medium">{b.title}</span>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={b.createdAt.toISOString()}>
                  {formatRelative(b.createdAt)}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
