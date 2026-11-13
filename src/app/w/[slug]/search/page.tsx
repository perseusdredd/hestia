import type { Metadata } from "next";
import { Search, SearchX } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { SearchForm } from "@/components/search/search-form";
import { SearchResults } from "@/components/search/search-results";
import { SEARCH_TYPE_META } from "@/components/search/search-types";
import { TypeChips } from "@/components/search/type-chips";
import { requireWorkspace } from "@/lib/tenant";
import { isServiceError } from "@/server/errors";
import {
  DEFAULT_LIMIT_PER_TYPE,
  parseSearchTypes,
  searchWorkspace,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  type SearchResponse,
} from "@/server/search";

export const metadata: Metadata = { title: "Ara" };

/** Results shown when a single type is selected. */
const FILTERED_LIMIT = 30;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string | string[]; type?: string | string[] }>;
}) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const sp = await searchParams;

  // Cap before trimming so a huge query string never reaches the service.
  const rawQ = first(sp.q).slice(0, SEARCH_MAX_LENGTH * 4);
  const q = rawQ.trim();
  const type = parseSearchTypes(first(sp.type))[0] ?? null;

  let result: SearchResponse | null = null;
  let error: string | null = null;
  if (q) {
    if (q.length < SEARCH_MIN_LENGTH) {
      error = `En az ${SEARCH_MIN_LENGTH} karakter yazın.`;
    } else if (q.length > SEARCH_MAX_LENGTH) {
      error = `Arama en fazla ${SEARCH_MAX_LENGTH} karakter olabilir.`;
    } else {
      try {
        result = await searchWorkspace(ctx, {
          q,
          types: type ? [type] : undefined,
          limitPerType: type ? FILTERED_LIMIT : DEFAULT_LIMIT_PER_TYPE,
        });
      } catch (e) {
        if (!isServiceError(e)) throw e;
        error = e.message;
      }
    }
  }

  const scope = type ? SEARCH_TYPE_META[type].label.toLocaleLowerCase("tr") : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ara"
        description="Mesajlar, yorumlar, yapılacaklar, dokümanlar, dosyalar ve etkinlikler arasında arayın."
      />

      <div className="space-y-3">
        <SearchForm slug={slug} q={q.slice(0, SEARCH_MAX_LENGTH)} type={type} error={error} />
        <TypeChips slug={slug} q={q} active={type} />
      </div>

      {!q ? (
        <EmptyState
          icon={Search}
          title="Ne aramak istersiniz?"
          description="Bir kelime veya ifade yazın; bu çalışma alanındaki içerikler arasında arayalım."
        />
      ) : result && result.total === 0 ? (
        <EmptyState
          icon={SearchX}
          title="Sonuç bulunamadı"
          description={
            <>
              “{q}” için {scope ? `${scope} arasında ` : ""}eşleşme yok. Farklı bir kelime deneyin
              {scope ? " veya tüm türlerde arayın" : ""}.
            </>
          }
        />
      ) : result ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            “{result.q}” için {result.groups.some((g) => g.hasMore) ? `${result.total}+` : result.total} sonuç
          </p>
          <SearchResults slug={slug} q={result.q} groups={result.groups} filtered={type !== null} />
        </div>
      ) : null}
    </div>
  );
}
