/**
 * Safe auto-linking of user text, shared by the message board and chat.
 * Pure module: produces tokens, never HTML.
 */

export type TextToken = { type: "text"; value: string } | { type: "link"; value: string; href: string };

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'"»…]+$/;

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCTUATION, "");
  // Drop unbalanced closing brackets: "(bkz. https://x.y/z)" -> "https://x.y/z".
  for (const [open, close] of [["(", ")"], ["[", "]"]] as const) {
    while (url.endsWith(close) && count(url, open) < count(url, close)) {
      url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
    }
  }
  return url;
}

/** Only http(s) URLs with a dotted host become links. */
export function safeHref(candidate: string): string | null {
  const withScheme = /^www\./i.test(candidate) ? `https://${candidate}` : candidate;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Split plain text into text and link tokens. Never produces HTML. */
export function tokenizeLinks(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = trimUrl(match[0]);
    const href = url ? safeHref(url) : null;
    if (!href) continue;
    if (start > last) tokens.push({ type: "text", value: text.slice(last, start) });
    tokens.push({ type: "link", value: url, href });
    last = start + url.length;
  }
  if (last < text.length) tokens.push({ type: "text", value: text.slice(last) });
  return tokens;
}
