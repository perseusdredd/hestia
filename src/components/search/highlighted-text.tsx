import type { HighlightedText as Highlighted } from "@/server/search";

/**
 * Renders text with <mark> around the given ranges. Plain React text nodes
 * only, so user content is always escaped (no dangerouslySetInnerHTML).
 */
export function HighlightedText({ value, className }: { value: Highlighted; className?: string }) {
  const { text, ranges } = value;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor || end > text.length || end <= start) continue;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={start} className="rounded-sm bg-primary/15 px-0.5 text-foreground">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <span className={className}>{parts}</span>;
}
