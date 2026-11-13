import { NextResponse } from "next/server";

import { getOptionalUser } from "@/lib/tenant";
import { acceptLocalUpload } from "@/server/files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

/**
 * Upload target for the LOCAL storage driver only (R2 uploads go straight to
 * the bucket with a presigned URL). The signed token from createPendingUpload
 * carries the server-generated key; the service re-checks the uploader's
 * membership and the declared size. The File row is created later by the
 * "complete" server action.
 */
export async function PUT(req: Request) {
  const user = await getOptionalUser();
  if (!user) return NextResponse.json({ error: "Oturum bulunamadı." }, { status: 401, headers: HEADERS });

  const token = new URL(req.url).searchParams.get("token");
  const lengthHeader = req.headers.get("content-length");
  const contentLength = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;

  const result = await acceptLocalUpload(user.id, token, req.body, contentLength);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: HEADERS });
  }
  return NextResponse.json({ ok: true, size: result.size }, { headers: HEADERS });
}
