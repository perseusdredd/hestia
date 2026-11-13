// Pure markdown helpers (no React): safe to import from server services.

/**
 * Deepest container nesting the renderer accepts. react-markdown recurses once
 * per nested blockquote/list level and overflows the stack somewhere below
 * ~1000 levels (runtime dependent), so this stays far below that.
 */
export const MAX_MARKDOWN_NESTING = 32;

// One container marker: ">" (space optional) or a list marker followed by a
// space/tab or the end of the line.
const CONTAINER_MARKER = /(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$))[ \t]*/y;

/**
 * Upper bound of block nesting per line: leading indentation / 2 (indented
 * nested lists) plus the run of leading ">" and list markers ("- > 1. > ...").
 * It over-counts on purpose; a false positive only means plain-text rendering.
 */
export function markdownNestingDepth(text: string): number {
  let max = 0;
  for (const line of text.split("\n")) {
    let i = 0;
    let indent = 0;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) {
      indent += line[i] === "\t" ? 4 : 1;
      i++;
    }
    let depth = Math.floor(indent / 2);
    CONTAINER_MARKER.lastIndex = i;
    while (CONTAINER_MARKER.lastIndex < line.length && CONTAINER_MARKER.exec(line)) depth++;
    if (depth > max) max = depth;
  }
  return max;
}

export function isMarkdownTooDeep(text: string, limit = MAX_MARKDOWN_NESTING): boolean {
  return markdownNestingDepth(text) > limit;
}

// A fenced code block, closed or running to the end of the text.
const FENCE = /^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm;

// Emphasis only when it wraps a word, so snake_case_names and 2*3*4 survive.
const EMPHASIS = /(^|[^\p{L}\p{N}_])(\*\*|__|~~|\*|_)(?=\S)(.+?)(?<=\S)\2(?![\p{L}\p{N}_])/gu;

/**
 * Strips markdown syntax so list excerpts stay plain text. Expects the RAW
 * text (line-anchored rules need the newlines); clip only the result.
 */
export function markdownToPlain(text: string): string {
  let out = text
    .replace(/\r\n?/g, "\n")
    .replace(FENCE, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\^[^\]\s]+\]:?/g, "")
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, " ")
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, " ")
    .replace(/^[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+)*(?:#{1,6}[ \t]+)?(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/`([^`\n]+)`/g, "$1");
  // Twice, for nested emphasis like **_x_**.
  out = out.replace(EMPHASIS, "$1$3").replace(EMPHASIS, "$1$3");
  return out.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
}

/** Plain-text excerpt for list cards: strip first, then clip. */
export function markdownExcerpt(body: string, max = 200): string {
  const flat = markdownToPlain(body);
  if (!flat) {
    if (!body.trim()) return "";
    return /^[ \t]*(`{3,}|~{3,})/m.test(body) ? "(kod bloğu)" : "(içerik yok)";
  }
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}
