import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/lib/db";
import type { ChatMessagesResponse } from "@/lib/pusher/chat-protocol";
import { getOptionalUser, type TenantContext } from "@/lib/tenant";
import { listLiveIdsFrom, listMessages, listMessagesAfterPage } from "@/server/chat";
import { isServiceError } from "@/server/errors";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * Same checks as requireWorkspace(), but answers with JSON status codes
 * instead of redirect/notFound pages (this is polled by fetch()).
 * 401 signed out, 404 not a member (never reveals whether the slug exists).
 */
async function resolveCtx(slug: string): Promise<TenantContext | 401 | 404> {
  const user = await getOptionalUser();
  if (!user) return 401;
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 64) return 404;
  const membership = await db.membership.findFirst({
    where: { userId: user.id, workspace: { slug } },
    select: { workspaceId: true, role: true },
  });
  if (!membership) return 404;
  return { userId: user.id, workspaceId: membership.workspaceId, role: membership.role };
}

/**
 * GET /api/chat/[slug]/messages
 *   (no params)            newest page (+ hasMore)
 *   ?before=<cursor>       older page before the cursor (+ hasMore)
 *   ?after=<cursor>        newer messages (polling / resync, + hasMoreAfter)
 *     &from=<cursor>       also return liveIds >= from so deletions can be synced
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await resolveCtx(slug);
  if (ctx === 401) return json({ error: "Oturum bulunamadı." }, 401);
  if (ctx === 404) return json({ error: "Bulunamadı." }, 404);

  const sp = req.nextUrl.searchParams;
  const before = sp.get("before");
  const after = sp.get("after");
  const from = sp.get("from");

  try {
    if (after) {
      const [page, live] = await Promise.all([
        listMessagesAfterPage(ctx, { after }),
        from ? listLiveIdsFrom(ctx, from) : Promise.resolve(null),
      ]);
      const body: ChatMessagesResponse = { messages: page.messages, hasMoreAfter: page.hasMoreAfter };
      if (live) {
        body.liveIds = live.ids;
        body.liveIdsComplete = live.complete;
      }
      return json(body);
    }
    const page = await listMessages(ctx, before ? { before } : {});
    const body: ChatMessagesResponse = { messages: page.messages, hasMore: page.hasMore };
    return json(body);
  } catch (e) {
    if (isServiceError(e)) {
      return json({ error: e.message }, e.code === "VALIDATION" ? 400 : e.code === "NOT_FOUND" ? 404 : 403);
    }
    throw e;
  }
}
