/**
 * @mentions inside markdown bodies (comments and posts).
 *
 * Stored form: `@[Display Name](user:<id>)` - a markdown link with the
 * "user:" scheme. The label is only a hint written by the client: it is never
 * trusted. The server keeps only ids that are CURRENT members of the
 * workspace (see resolveMentionedMembers in src/server/comments.ts), and the
 * Markdown component renders the name looked up in the DB, or the label as
 * escaped plain text when the id is not a member.
 *
 * Pure helpers only (no DB, no React): shared by server and client.
 */

/** Ids look like cuids; anything else is not a mention. */
export const MENTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** At most this many distinct members are mentioned (notified) per body. */
export const MAX_MENTIONS = 20;
export const MENTION_LABEL_MAX = 80;

const TOKEN = /@?\[([^\[\]\n]{1,80})\]\(user:([A-Za-z0-9_-]{1,64})\)/g;
// Approximate code detection: a fenced block (to its closing fence or the
// end) or an inline code span. Tokens inside code are left alone.
const CODE = /(```|~~~)[\s\S]*?(?:\1|$)|`[^`\n]*`/g;

/** "user:<id>" -> id, else null. Used by the Markdown renderer for hrefs. */
export function mentionIdFromHref(href: string | null | undefined): string | null {
  if (!href || !href.startsWith("user:")) return null;
  const id = href.slice(5);
  return MENTION_ID_PATTERN.test(id) ? id : null;
}

/** Applies `replace` to the parts of `body` outside code. */
function outsideCode(body: string, replace: (text: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of body.matchAll(CODE)) {
    const at = m.index ?? 0;
    out += replace(body.slice(last, at)) + m[0];
    last = at + m[0].length;
  }
  return out + replace(body.slice(last));
}

function withoutCode(body: string): string {
  return body.replace(CODE, " ");
}

/**
 * Distinct mentioned ids in order of first appearance, capped at `max`.
 * Tokens inside code spans / fenced code blocks do not count (they render as
 * code, not as mentions). Malformed tokens are ignored.
 */
export function parseMentionIds(body: string, max: number = MAX_MENTIONS): string[] {
  if (typeof body !== "string" || !body) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of withoutCode(body).matchAll(TOKEN)) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** Label safe to put inside the token's [...]: no brackets, parens, backslashes or newlines. */
export function sanitizeMentionLabel(name: string): string {
  const clean = name.replace(/[\[\]()\\\n\r`*_~<>]/g, " ").replace(/\s+/g, " ").trim();
  return (clean || "üye").slice(0, MENTION_LABEL_MAX).trim();
}

/** The stored token for `user`. */
export function formatMentionToken(user: { id: string; name: string }): string {
  return `@[${sanitizeMentionLabel(user.name)}](user:${user.id})`;
}

/**
 * Rewrites `@[Label](user:id)` to `[@Label](user:id)` so the "@" becomes part
 * of the link text and the whole mention renders as one chip.
 */
export function mentionsForRender(body: string): string {
  return outsideCode(body, (text) =>
    text.replace(TOKEN, (_all, label: string, id: string) => `[@${label}](user:${id})`),
  );
}

/**
 * Plain-text form for notification bodies and search snippets: every token
 * becomes "@Name" where Name is the DB name from `names` (members only),
 * otherwise the client-written label.
 */
export function mentionsToPlain(body: string, names: Record<string, string> = {}): string {
  return outsideCode(body, (text) =>
    text.replace(TOKEN, (_all, label: string, id: string) =>
      Object.hasOwn(names, id) ? `@${names[id]}` : `@${label}`,
    ),
  );
}
