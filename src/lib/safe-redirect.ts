// Edge-safe helpers (used by middleware) - no Node-only imports here.

export const DEFAULT_AFTER_LOGIN = "/app";

/**
 * Returns `value` only when it is a same-origin relative path ("/foo?x=1").
 * Rejects absolute URLs, protocol-relative URLs ("//evil.com"), backslash
 * tricks ("/\\evil.com") and control characters. Falls back to `fallback`.
 */
export function safeCallbackUrl(
  value: string | null | undefined,
  fallback: string = DEFAULT_AFTER_LOGIN,
): string {
  if (!value || typeof value !== "string") return fallback;
  if (value.length > 2048) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  try {
    const base = "http://hestia.local";
    const url = new URL(value, base);
    if (url.origin !== base) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

export function isGoogleAuthEnabled(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}
