import Link from "next/link";

import { cn } from "@/lib/utils";
import type { MessageCategoryDto } from "@/server/message-categories";

/** Filter chips for the message list: server-side links (?kat=<id> or ?taslak=1). */
export function CategoryFilter({
  slug,
  categories,
  activeCategoryId,
  draftsOnly,
}: {
  slug: string;
  categories: MessageCategoryDto[];
  activeCategoryId: string | null;
  draftsOnly: boolean;
}) {
  const base = `/w/${slug}/messages`;
  const chips: { key: string; href: string; label: string; active: boolean }[] = [
    { key: "all", href: base, label: "Tümü", active: !activeCategoryId && !draftsOnly },
    ...categories.map((c) => ({
      key: c.id,
      href: `${base}?kat=${encodeURIComponent(c.id)}`,
      label: `${c.emoji} ${c.name}`,
      active: activeCategoryId === c.id,
    })),
    { key: "drafts", href: `${base}?taslak=1`, label: "Taslaklarım", active: draftsOnly },
  ];
  return (
    <nav aria-label="Kategori filtresi" className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <Link
          key={c.key}
          href={c.href}
          aria-current={c.active ? "page" : undefined}
          className={cn(
            "rounded-full border px-3 py-1 text-sm transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            c.active && "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          {c.label}
        </Link>
      ))}
    </nav>
  );
}
