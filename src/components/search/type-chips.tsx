import Link from "next/link";

import { SEARCH_TYPE_META, searchHref } from "@/components/search/search-types";
import { cn } from "@/lib/utils";
import { SEARCH_TYPES, type SearchType } from "@/server/search";

const chipClass =
  "inline-flex h-8 pointer-coarse:h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

/** Type filter as plain links (no JS needed). */
export function TypeChips({ slug, q, active }: { slug: string; q: string; active: SearchType | null }) {
  const chip = (type: SearchType | null, label: string, Icon?: React.ComponentType<{ className?: string }>) => {
    const isActive = active === type;
    return (
      <li key={type ?? "all"}>
        <Link
          href={searchHref(slug, q, type)}
          aria-current={isActive ? "page" : undefined}
          className={cn(
            chipClass,
            isActive
              ? "border-primary/40 bg-primary-soft font-medium text-primary-text"
              : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
          {label}
        </Link>
      </li>
    );
  };

  return (
    <nav aria-label="Sonuç türü">
      <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        {chip(null, "Tümü")}
        {SEARCH_TYPES.map((t) => chip(t, SEARCH_TYPE_META[t].label, SEARCH_TYPE_META[t].icon))}
      </ul>
    </nav>
  );
}
