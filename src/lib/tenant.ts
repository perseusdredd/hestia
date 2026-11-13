import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Membership, Role, Workspace } from "@prisma/client";
import type { Session } from "next-auth";
import { decode } from "next-auth/jwt";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { hasRole } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { ServiceError } from "@/server/errors";

export type { TenantContext };
export { hasRole };

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: Date | null;
};

/** Where a browser with a revoked or orphaned JWT is sent: it clears the cookie. */
export const SESSION_EXPIRED_PATH = "/session-expired";

/** /session-expired URL that brings the user back to `returnTo` after signing in again. */
export function sessionExpiredUrl(returnTo: string): string {
  return `${SESSION_EXPIRED_PATH}?callbackUrl=${encodeURIComponent(returnTo)}`;
}

type UserRow = SessionUser & { sessionVersion: number };

const loadUser = cache(async (userId: string): Promise<UserRow | null> => {
  return db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      image: true,
      emailVerified: true,
      sessionVersion: true,
    },
  });
});

/**
 * JWTs carry the sessionVersion they were issued with (see src/auth.ts). A
 * password change/reset bumps the row, so older tokens stop matching. Tokens
 * issued before versioning existed carry none and count as version 0.
 */
function isCurrentSession(session: Session, row: UserRow): boolean {
  return (session.sessionVersion ?? 0) === row.sessionVersion;
}

/** Auth.js session cookie names (https deployments use the __Secure- prefix; the name is also the JWT salt). */
const SESSION_COOKIES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

/**
 * sessionVersion of a JWT that a server action re-issued during THIS request
 * (changePasswordAction calls unstable_update after bumping the version).
 * The page re-render that follows the action runs in the same request:
 * auth() still reads the old cookie from the request headers, while
 * cookies() already reflects the cookie the action set. Returns the fresh
 * token's version when it decodes with AUTH_SECRET for the same user, else
 * null. Without a re-issue the store holds the request's own (stale) token,
 * so nothing new is accepted.
 */
async function reissuedSessionVersion(userId: string): Promise<number | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  let store: Awaited<ReturnType<typeof cookies>>;
  try {
    store = await cookies();
  } catch {
    return null; // outside a request scope
  }
  for (const name of SESSION_COOKIES) {
    const value = store.get(name)?.value;
    if (!value) continue;
    try {
      const token = await decode({ token: value, secret, salt: name });
      const tokenUser = token?.id ?? token?.sub;
      if (tokenUser === userId && typeof token?.sessionVersion === "number") return token.sessionVersion;
    } catch {
      // not a token we issued (or expired): ignore
    }
  }
  return null;
}

type SessionCheck =
  | { status: "signed-out" }
  | { status: "revoked" }
  | { status: "ok"; user: SessionUser };

/**
 * The one session check: JWT present, user row still exists, versions match.
 * Every page, action and route handler authenticates through
 * requireUser()/getOptionalUser(), which both use this.
 */
export const checkSession = cache(async (): Promise<SessionCheck> => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!session || !userId) return { status: "signed-out" };
  const row = await loadUser(userId);
  // Row gone (deleted account) or JWT revoked by a password change/reset.
  if (!row) return { status: "revoked" };
  if (!isCurrentSession(session, row) && (await reissuedSessionVersion(userId)) !== row.sessionVersion) {
    return { status: "revoked" };
  }
  const { sessionVersion: _version, ...user } = row;
  void _version;
  return { status: "ok", user };
});

/** Signed-in user (fresh from the DB). Redirects to /login when signed out. */
export const requireUser = cache(async (): Promise<SessionUser> => {
  const check = await checkSession();
  if (check.status === "signed-out") redirect("/login");
  // Revoked or orphaned JWT: clear the cookie, then land on /login.
  if (check.status === "revoked") redirect(SESSION_EXPIRED_PATH);
  return check.user;
});

/**
 * Signed-in user or null - for public pages and route handlers (which answer
 * 401 on null). A revoked JWT counts as signed out.
 */
export const getOptionalUser = cache(async (): Promise<SessionUser | null> => {
  const check = await checkSession();
  return check.status === "ok" ? check.user : null;
});

const loadMembership = cache(
  async (userId: string, slug: string): Promise<(Membership & { workspace: Workspace }) | null> => {
    return db.membership.findFirst({
      where: { userId, workspace: { slug } },
      include: { workspace: true },
    });
  },
);

/**
 * Resolve the workspace for `slug` and the signed-in user's membership.
 * - signed out            -> redirect("/login")
 * - not a member          -> notFound() (never reveals whether the slug exists)
 * - role below `minRole`  -> throws ServiceError("FORBIDDEN")
 * Call it FIRST in every tenant page, server action and route handler.
 */
export async function requireWorkspace(
  slug: string,
  minRole?: Role,
): Promise<{
  user: SessionUser;
  workspace: Workspace;
  membership: Membership;
  ctx: TenantContext;
}> {
  const user = await requireUser();
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 64) notFound();
  const found = await loadMembership(user.id, slug);
  if (!found) notFound();
  const { workspace, ...membership } = found;
  if (minRole && !hasRole(membership.role, minRole)) {
    throw new ServiceError("FORBIDDEN", "Bu işlem için yetkiniz yok.");
  }
  return {
    user,
    workspace,
    membership,
    ctx: { userId: user.id, workspaceId: workspace.id, role: membership.role },
  };
}
