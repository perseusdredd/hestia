/**
 * Response security headers. Pure functions (no next/*, no process.env reads)
 * so they run in the Edge middleware and in unit tests alike; the caller
 * passes in what it read from the environment.
 *
 * Nonce mechanism (Next 15 App Router): the middleware puts the policy on the
 * REQUEST headers as well; app-render reads `content-security-policy`, takes
 * the nonce from `script-src` (getScriptNonceFromHeader) and stamps it on every
 * framework/bootstrap script. Only dynamically rendered pages get a fresh
 * nonce, which is why the root layout reads headers() (see layout.tsx).
 */

export type CspOptions = {
  /** Base64 nonce for this request. */
  nonce: string;
  /** `next dev`: HMR needs eval and a websocket back to the dev server. */
  isDev: boolean;
  /** Pusher cluster when realtime is configured (e.g. "eu"), otherwise null. */
  pusherCluster: string | null;
  /** R2 when STORAGE_DRIVER=r2 is configured, otherwise null. */
  r2: { accountId: string; bucket: string } | null;
  /** Google OAuth provider enabled (form-action redirect target, avatar host). */
  googleAuth: boolean;
};

/** Only plain host labels end up in the header (no ';', spaces or quotes). */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const R2_ACCOUNT = /^[a-f0-9]{32}$/i;
/** S3/R2 bucket names: lowercase letters, digits, hyphens (dots break TLS on R2's wildcard cert). */
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const NONCE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Browser-facing R2 origins: path-style and virtual-hosted presigned URLs. */
export function r2Origins(r2: CspOptions["r2"]): string[] {
  if (!r2 || !R2_ACCOUNT.test(r2.accountId)) return [];
  const account = r2.accountId.toLowerCase();
  const origins = [`https://${account}.r2.cloudflarestorage.com`];
  if (R2_BUCKET.test(r2.bucket)) origins.push(`https://${r2.bucket}.${account}.r2.cloudflarestorage.com`);
  return origins;
}

/** pusher-js with `cluster` + forceTLS: websocket on ws-<c>, HTTP fallbacks on sockjs-<c>. */
export function pusherOrigins(cluster: string | null): string[] {
  if (!cluster || !HOST_LABEL.test(cluster)) return [];
  return [`wss://ws-${cluster}.pusher.com`, `https://sockjs-${cluster}.pusher.com`];
}

export const GOOGLE_OAUTH_ORIGIN = "https://accounts.google.com";
/** Profile pictures stored by the Google provider (User.image). */
export const GOOGLE_AVATAR_ORIGIN = "https://lh3.googleusercontent.com";

/**
 * Content-Security-Policy for HTML responses.
 *
 * style-src keeps 'unsafe-inline' on purpose, after checking what actually
 * runs: base-ui and React set positioning through `style` attributes (no
 * nonce can cover attributes), sonner injects its stylesheet with a plain
 * <style> element at runtime, and next-themes' disableTransitionOnChange
 * appends an un-nonced <style>. Adding a nonce to style-src would make the
 * browser ignore 'unsafe-inline' and break all of those. Scripts are strict.
 */
export function buildContentSecurityPolicy(opts: CspOptions): string {
  if (!NONCE.test(opts.nonce)) throw new Error("Invalid CSP nonce");
  const r2 = r2Origins(opts.r2);
  const pusher = pusherOrigins(opts.pusherCluster);

  const scriptSrc = ["'self'", `'nonce-${opts.nonce}'`, "'strict-dynamic'"];
  if (opts.isDev) scriptSrc.push("'unsafe-eval'");

  const connectSrc = ["'self'", ...pusher, ...r2];
  if (opts.isDev) connectSrc.push("ws:", "wss:");

  const imgSrc = ["'self'", "data:", "blob:", ...r2];
  if (opts.googleAuth) imgSrc.push(GOOGLE_AVATAR_ORIGIN);

  const formAction = ["'self'"];
  if (opts.googleAuth) formAction.push(GOOGLE_OAUTH_ORIGIN);

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", imgSrc],
    ["media-src", ["'self'", "blob:", ...r2]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", connectSrc],
    // PDF previews: the inline route (or, on R2, its presigned redirect) in an iframe.
    ["frame-src", ["'self'", ...r2]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", formAction],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/** Pages whose URL carries a secret token: never leak it through Referer. */
export function isTokenPath(pathname: string): boolean {
  return (
    pathname.startsWith("/reset-password/") ||
    pathname.startsWith("/verify-email/") ||
    pathname.startsWith("/invite/")
  );
}

export const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "bluetooth=()",
  "hid=()",
  "midi=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
  "display-capture=()",
  "browsing-topics=()",
  "interest-cohort=()",
].join(", ");

export type StaticHeaderOptions = { pathname: string; isProduction: boolean };

/**
 * Headers every response gets, besides the CSP. Route handlers under /api/
 * may set their own Referrer-Policy/CSP; Next keeps a header the middleware
 * already set over the handler's value (send-response only appends absent
 * headers), so API paths get the strictest referrer policy and no CSP here.
 */
export function staticSecurityHeaders({ pathname, isProduction }: StaticHeaderOptions): Record<string, string> {
  const api = pathname.startsWith("/api/");
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": api || isTokenPath(pathname) ? "no-referrer" : "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
  };
  if (isProduction) headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  return headers;
}

/** API responses get no page CSP: handlers such as /api/files/[id] set their own, stricter one. */
export function needsPageCsp(pathname: string): boolean {
  return !pathname.startsWith("/api/");
}
