import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { buildIcs } from "@/lib/ical";
import { getOptionalUser, type TenantContext } from "@/lib/tenant";
import { listEventsForFeed } from "@/server/calendar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/calendar/[slug]: read-only iCalendar (.ics) feed of the workspace's
 * events; recurring events are exported once with an RRULE.
 *
 * Access: the signed-in session cookie of a workspace member (same checks as
 * the notifications route: 401 signed out, 404 not a member). There is no
 * per-user token, so the feed is downloadable from the browser (and can be
 * imported into Google/Apple/Outlook) but is not a live subscription URL.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getOptionalUser();
  if (!user) return NextResponse.json({ error: "Oturum bulunamadı." }, { status: 401, headers: NO_STORE });
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 64) {
    return NextResponse.json({ error: "Bulunamadı." }, { status: 404, headers: NO_STORE });
  }
  const membership = await db.membership.findFirst({
    where: { userId: user.id, workspace: { slug } },
    select: { workspaceId: true, role: true, workspace: { select: { name: true } } },
  });
  if (!membership) return NextResponse.json({ error: "Bulunamadı." }, { status: 404, headers: NO_STORE });
  const ctx: TenantContext = { userId: user.id, workspaceId: membership.workspaceId, role: membership.role };

  const events = await listEventsForFeed(ctx);
  const body = buildIcs(events, { name: membership.workspace.name });
  return new NextResponse(body, {
    headers: {
      ...NO_STORE,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug.replace(/[^A-Za-z0-9_-]/g, "") || "calendar"}.ics"`,
    },
  });
}
