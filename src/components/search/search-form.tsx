import { Search } from "lucide-react";

import { FieldError } from "@/components/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SEARCH_MAX_LENGTH, type SearchType } from "@/server/search";

/** Plain GET form: works without JavaScript. */
export function SearchForm({
  slug,
  q,
  type,
  error,
}: {
  slug: string;
  q: string;
  type: SearchType | null;
  error?: string | null;
}) {
  return (
    <form action={`/w/${slug}/search`} method="get" role="search" className="space-y-1.5">
      <div className="flex gap-2">
        <label htmlFor="search-q" className="sr-only">
          Çalışma alanında ara
        </label>
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id="search-q"
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Mesaj, iş, doküman, dosya veya etkinlik ara"
            maxLength={SEARCH_MAX_LENGTH}
            autoComplete="off"
            enterKeyHint="search"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "search-q-error" : undefined}
            className="h-9 pl-8"
          />
        </div>
        {type ? <input type="hidden" name="type" value={type} /> : null}
        <Button type="submit" size="lg">
          Ara
        </Button>
      </div>
      <FieldError id="search-q-error" errors={error ? [error] : null} />
    </form>
  );
}
