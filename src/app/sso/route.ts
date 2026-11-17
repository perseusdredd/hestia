import { NextResponse, type NextRequest } from "next/server";

import { signIn } from "@/auth";
import { DEFAULT_AFTER_LOGIN, safeCallbackUrl } from "@/lib/safe-redirect";

// GET /sso?token=...&next=/w/slug : one-click sign-in coming from Perseus.
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const next = safeCallbackUrl(request.nextUrl.searchParams.get("next"), DEFAULT_AFTER_LOGIN);
  try {
    // Throws a redirect on success (Auth.js sets the session cookie first).
    await signIn("sso", { token, redirectTo: next });
  } catch (error) {
    if (error instanceof Error && "digest" in error && String((error as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT")) {
      throw error;
    }
  }
  const login = new URL("/login", process.env.AUTH_URL || request.url);
  return NextResponse.redirect(login);
}
