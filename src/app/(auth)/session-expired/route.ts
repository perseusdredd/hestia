import type { NextRequest } from "next/server";
import { redirect } from "next/navigation";

import { signOut } from "@/auth";
import { DEFAULT_AFTER_LOGIN, safeCallbackUrl } from "@/lib/safe-redirect";
import { checkSession } from "@/lib/tenant";

/*
 * requireUser() sends a browser here when its JWT was revoked (password
 * change/reset bumped User.sessionVersion) or its user row is gone. Clearing
 * the cookie needs a Route Handler (pages cannot set cookies). A still-valid
 * session is NOT signed out, so a third-party link to this URL cannot log
 * anyone out. An optional same-origin `callbackUrl` is carried to /login.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("callbackUrl");
  const safe = raw ? safeCallbackUrl(raw) : null;
  const check = await checkSession();
  if (check.status === "ok") redirect(safe ?? DEFAULT_AFTER_LOGIN);
  const suffix = safe ? `callbackUrl=${encodeURIComponent(safe)}` : "";
  if (check.status === "signed-out") redirect(suffix ? `/login?${suffix}` : "/login");
  await signOut({ redirectTo: suffix ? `/login?expired=1&${suffix}` : "/login?expired=1" });
}
