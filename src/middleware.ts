import NextAuth from "next-auth";
import { type NextRequest, NextResponse } from "next/server";

import { authConfig } from "@/auth.config";
import { DEFAULT_AFTER_LOGIN, isGoogleAuthEnabled, safeCallbackUrl } from "@/lib/safe-redirect";
import { buildContentSecurityPolicy, needsPageCsp, staticSecurityHeaders } from "@/lib/security-headers";

// Edge-safe instance: only reads/validates the JWT cookie, never touches the DB.
const { auth } = NextAuth(authConfig);

const AUTH_PAGES = new Set(["/login", "/register"]);

function isPublic(pathname: string): boolean {
  return (
    pathname === "/" ||
    AUTH_PAGES.has(pathname) ||
    pathname.startsWith("/invite/") ||
    pathname.startsWith("/api/auth/") ||
    // Mailed account flows (reached from an email, usually signed out).
    pathname === "/forgot-password" ||
    pathname.startsWith("/reset-password/") ||
    pathname.startsWith("/verify-email/") ||
    // Clears a revoked session cookie; the route itself decides what to do.
    pathname === "/session-expired" ||
    // The page answers 404 itself unless enabled and signed in.
    pathname === "/dev/outbox" ||
    // Uptime probe: no session, no secrets in the answer.
    pathname === "/api/health" ||
    // Vercel Cron: the route checks the CRON_SECRET bearer token itself.
    pathname.startsWith("/api/cron/")
  );
}

/** Same rule as getRealtimeConfig(): Pusher only when every credential is present. */
function pusherCluster(): string | null {
  const configured =
    process.env.PUSHER_APP_ID?.trim() && process.env.PUSHER_SECRET?.trim() && process.env.NEXT_PUBLIC_PUSHER_KEY?.trim();
  return configured ? process.env.NEXT_PUBLIC_PUSHER_CLUSTER?.trim() || "eu" : null;
}

function r2Config(): { accountId: string; bucket: string } | null {
  if ((process.env.STORAGE_DRIVER || "local").toLowerCase() !== "r2") return null;
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  return accountId && bucket ? { accountId, bucket } : null;
}

function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function pageCsp(nonce: string): string {
  return buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    pusherCluster: pusherCluster(),
    r2: r2Config(),
    googleAuth: isGoogleAuthEnabled(),
  });
}

function withSecurityHeaders(res: Response, pathname: string, csp: string | null): Response {
  for (const [name, value] of Object.entries(
    staticSecurityHeaders({ pathname, isProduction: process.env.NODE_ENV === "production" }),
  )) {
    res.headers.set(name, value);
  }
  // Never replace a policy something downstream already chose.
  if (csp && !res.headers.has("Content-Security-Policy")) res.headers.set("Content-Security-Policy", csp);
  return res;
}

function route(req: NextRequest, signedIn: boolean, forward: () => NextResponse): NextResponse {
  const { pathname, search } = req.nextUrl;

  if (AUTH_PAGES.has(pathname)) {
    if (signedIn) {
      const target = safeCallbackUrl(req.nextUrl.searchParams.get("callbackUrl"), DEFAULT_AFTER_LOGIN);
      return NextResponse.redirect(new URL(target, req.nextUrl.origin));
    }
    return forward();
  }

  if (isPublic(pathname)) return forward();

  if (!signedIn) {
    // API clients (fetch, polling) get a machine-readable answer, not a login page.
    // Route handlers still re-check the session and membership themselves.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Oturum açmanız gerekiyor." }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", safeCallbackUrl(pathname + search));
    return NextResponse.redirect(loginUrl);
  }

  return forward();
}

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const nonce = needsPageCsp(pathname) ? createNonce() : null;
  const csp = nonce ? pageCsp(nonce) : null;

  // The policy also goes on the request: Next reads the nonce from it and
  // applies it to its own scripts; the root layout reads it for next-themes.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete("content-security-policy");
  requestHeaders.delete("content-security-policy-report-only");
  requestHeaders.delete("x-nonce");
  if (nonce && csp) {
    requestHeaders.set("content-security-policy", csp);
    requestHeaders.set("x-nonce", nonce);
  }

  const forward = () => NextResponse.next({ request: { headers: requestHeaders } });
  return withSecurityHeaders(route(req, Boolean(req.auth?.user), forward), pathname, csp);
});

export const config = {
  // Skip Next internals and static files (anything with a file extension).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)"],
};
