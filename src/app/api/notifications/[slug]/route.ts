import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getOptionalUser, type TenantContext } from "@/lib/tenant";
import { NOTIFICATION_BELL_ITEMS, listNotifications, unreadCount } from "@/server/notifications";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Same checks as requireWorkspace(), answered as JSON (401 signed out, 404 not a member). */
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

/** GET /api/notifications/[slug]: unread count + latest notifications for the bell. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await resolveCtx(slug);
  if (ctx === 401) return json({ error: "Oturum bulunamadı." }, 401);
  if (ctx === 404) return json({ error: "Bulunamadı." }, 404);
  const [unread, page] = await Promise.all([
    unreadCount(ctx),
    listNotifications(ctx, { take: NOTIFICATION_BELL_ITEMS }),
  ]);
  return json({ unread, items: page.items });
}
