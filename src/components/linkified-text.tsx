import { Fragment } from "react";

import { tokenizeLinks } from "@/lib/linkify";
import { cn } from "@/lib/utils";

/** Plain text with safe http(s) auto-linking. React escapes every text node. */
export function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {tokenizeLinks(text).map((t, i) =>
        t.type === "link" ? (
          <a
            key={i}
            href={t.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            className="break-all text-primary-text underline underline-offset-2 hover:no-underline"
          >
            {t.value}
          </a>
        ) : (
          <Fragment key={i}>{t.value}</Fragment>
        ),
      )}
    </>
  );
}

/** A block of user text: line breaks preserved, links safe, no dangerouslySetInnerHTML. */
export function RichText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("text-sm leading-relaxed break-words whitespace-pre-wrap", className)}>
      <LinkifiedText text={text} />
    </div>
  );
}
