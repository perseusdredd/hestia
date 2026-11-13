/** Escape a user-supplied string for safe use in HTML text and attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Thrown when a value destined for a mail header contains a line break or NUL. */
export class MailHeaderError extends Error {
  constructor(field: string) {
    super(`Mail header "${field}" contains a forbidden control character.`);
    this.name = "MailHeaderError";
  }
}

// CR, LF, NUL and the Unicode line/paragraph separators: any of these in a
// header value could start a new header (header injection).
const HEADER_BREAK = /[\r\n\0\u0085\u2028\u2029]/;

export function hasHeaderBreak(value: string): boolean {
  return HEADER_BREAK.test(value);
}

/** Throws MailHeaderError when `value` cannot be placed into a header verbatim. */
export function assertHeaderSafe(field: string, value: string): void {
  if (hasHeaderBreak(value)) throw new MailHeaderError(field);
}

/**
 * Collapse whitespace (incl. line breaks) of a user-supplied string that is
 * interpolated into a header such as the subject, and cap its length.
 */
export function headerText(value: string, max = 80): string {
  const flat = value.replace(/[\s\0\u0085\u2028\u2029]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
