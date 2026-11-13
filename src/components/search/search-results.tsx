import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";

import { downloadHref } from "@/app/w/[slug]/files/paths";
import { formatBytes, ItemIcon } from "@/components/files/file-meta";
import { HighlightedText } from "@/components/search/highlighted-text";
import { SEARCH_TYPE_META, searchHref } from "@/components/search/search-types";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { SearchGroup, SearchResult } from "@/server/search";

const rowClass =
  "flex min-w-0 flex-1 items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

function dateLabel(r: SearchResult): string {
  if (r.dateKind === "starts") return formatDateTime(r.date);
  const rel = formatRelative(r.date);
  return r.dateKind === "updated" ? `${rel} düzenlendi` : rel;
}

function ResultIcon({ result }: { result: SearchResult }) {
  if (result.type === "file") {
    return <ItemIcon kind="file" mimeType={result.file?.mimeType} name={result.title.text} />;
  }
  if (result.type === "folder") return <ItemIcon kind="folder" />;
  if (result.type === "document") return <ItemIcon kind="document" />;
  if (result.author) return <UserAvatar user={result.author} size="sm" className="mt-0.5" />;
  const Icon = SEARCH_TYPE_META[result.type].icon;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

function ResultRow({ slug, result }: { slug: string; result: SearchResult }) {
  const meta: string[] = [];
  if (result.type === "comment") meta.push("Yorum");
  if (result.context && result.type !== "comment") meta.push(result.context);
  if (result.file) meta.push(formatBytes(result.file.size));
  if (result.author) meta.push(displayName(result.author));
  meta.push(dateLabel(result));

  return (
    <li className="flex items-start gap-1">
      <Link href={`/w/${slug}/${result.path}`} className={rowClass}>
        <ResultIcon result={result} />
        <span className="min-w-0 flex-1">
          <HighlightedText value={result.title} className="block font-medium break-words" />
          {result.snippet ? (
            <HighlightedText
              value={result.snippet}
              className="mt-0.5 line-clamp-2 block text-sm break-words text-muted-foreground"
            />
          ) : null}
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {meta.join(" · ")}
          </span>
        </span>
      </Link>
      {result.file ? (
        <a
          href={downloadHref(result.file.id)}
          download
          className="mt-2 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={`${result.title.text} dosyasını indir`}
          title="İndir"
        >
          <Download className="size-4" aria-hidden />
        </a>
      ) : null}
    </li>
  );
}

export function SearchResults({
  slug,
  q,
  groups,
  filtered,
}: {
  slug: string;
  q: string;
  groups: SearchGroup[];
  /** True when a single type is selected (no "show all" link needed). */
  filtered: boolean;
}) {
  return (
    <div className="space-y-4">
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => {
          const { label, icon: Icon } = SEARCH_TYPE_META[g.type];
          return (
            <section
              key={g.type}
              aria-label={label}
              className="min-w-0 rounded-xl border bg-card"
            >
              <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <h2 className="flex items-center gap-2 font-medium">
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                  {label}
                  <span className="text-sm font-normal text-muted-foreground">
                    {g.hasMore ? `${g.items.length}+` : g.items.length}
                  </span>
                </h2>
                {g.hasMore && !filtered ? (
                  <Link
                    href={searchHref(slug, q, g.type)}
                    className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                  >
                    Tümünü gör
                    <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                ) : null}
              </header>
              <ul className="p-2">
                {g.items.map((r) => (
                  <ResultRow key={`${r.type}-${r.id}`} slug={slug} result={r} />
                ))}
              </ul>
              {g.hasMore && filtered ? (
                <p className="border-t px-4 py-2.5 text-sm text-muted-foreground">
                  İlk {g.items.length} sonuç gösteriliyor. Daha fazlası için aramayı daraltın.
                </p>
              ) : null}
            </section>
          );
        })}
    </div>
  );
}
