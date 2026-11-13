import Link from "next/link";
import { ChevronRight, HardDrive } from "lucide-react";

import { folderHref } from "@/app/w/[slug]/files/paths";

/** "Dosyalar > A > B" trail. The last crumb is plain text unless `linkLast`. */
export function FilesBreadcrumbs({
  slug,
  crumbs,
  linkLast = false,
}: {
  slug: string;
  crumbs: { id: string; name: string }[];
  linkLast?: boolean;
}) {
  const linkClass =
    "truncate rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  return (
    <nav aria-label="Konum" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <li className="flex items-center gap-1">
          <HardDrive className="size-3.5" aria-hidden />
          {crumbs.length === 0 && !linkLast ? (
            <span className="font-medium text-foreground" aria-current="page">
              Dosyalar
            </span>
          ) : (
            <Link href={folderHref(slug)} className={linkClass}>
              Dosyalar
            </Link>
          )}
        </li>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={c.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
              {last && !linkLast ? (
                <span className="max-w-48 truncate font-medium text-foreground" aria-current="page">
                  {c.name}
                </span>
              ) : (
                <Link href={folderHref(slug, c.id)} className={`${linkClass} max-w-40`}>
                  {c.name}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
