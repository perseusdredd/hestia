/**
 * Trusted absolute origin for links placed into emails.
 *
 * Emailed links are never built from the request's Host / X-Forwarded-Host
 * headers: a forged Host on e.g. /forgot-password would otherwise make the
 * victim's reset email point at an attacker's server (link poisoning).
 * Order: AUTH_URL (operator-configured) -> VERCEL_PROJECT_PRODUCTION_URL (set
 * by the platform) -> http://localhost:3000 outside production. In production
 * without either, building a link fails and the mail is not written.
 */
export class MailOriginError extends Error {
  constructor() {
    super("AUTH_URL is not set; cannot build links for emails.");
    this.name = "MailOriginError";
  }
}

function normalize(raw: string): string | null {
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function getAppOrigin(): string {
  const fromAuth = process.env.AUTH_URL?.trim();
  if (fromAuth) {
    const origin = normalize(fromAuth);
    if (origin) return origin;
  }
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) {
    const origin = normalize(vercel);
    if (origin) return origin;
  }
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";
  throw new MailOriginError();
}

/** Absolute link on the trusted origin; `path` must start with "/". */
export function appLink(path: string): string {
  return `${getAppOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}
