import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { publishDueScheduled } from "@/server/scheduled-posts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const HEADERS = { "Cache-Control": "no-store" } as const;

/** Constant-time comparison; hashing first makes both sides the same length. */
function bearerMatches(header: string | null, secret: string): boolean {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const given = createHash("sha256").update(match[1].trim()).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected);
}

/**
 * Scheduled message publishing ("Zamanla"), scheduled in vercel.json. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set on the project.
 * Disabled (503) while CRON_SECRET is unset; 401 for any other caller.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "Cron is disabled: CRON_SECRET is not set." }, { status: 503, headers: HEADERS });
  }
  if (!bearerMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: HEADERS });
  }
  const published = await publishDueScheduled(new Date());
  console.info("[cron/publish-scheduled] published", published);
  return NextResponse.json({ ok: true, published }, { headers: HEADERS });
}
