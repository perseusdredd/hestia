import { NextResponse } from "next/server";

import { contentDisposition, downloadContentType } from "@/lib/storage";
import { getOptionalUser } from "@/lib/tenant";
import { isServiceError } from "@/server/errors";
import { authorizeFileAccess, getFileDownload } from "@/server/files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Referrer-Policy": "no-referrer",
} as const;

function notFoundResponse() {
  return NextResponse.json({ error: "Dosya bulunamadı." }, { status: 404, headers: SECURITY_HEADERS });
}

/**
 * Authorised download. The membership check runs here (not in a layout):
 * signed-out -> 401, unknown file or not a member -> 404 (same response).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  const user = await getOptionalUser();
  if (!user) {
    return NextResponse.json({ error: "Oturum bulunamadı." }, { status: 401, headers: SECURITY_HEADERS });
  }

  const ctx = await authorizeFileAccess(user.id, fileId);
  if (!ctx) return notFoundResponse();

  try {
    const { file, download } = await getFileDownload(ctx, fileId);
    if (download.kind === "redirect") {
      return new NextResponse(null, {
        status: 302,
        headers: { ...SECURITY_HEADERS, Location: download.url },
      });
    }
    return new NextResponse(download.stream, {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": downloadContentType(file.mimeType),
        "Content-Disposition": contentDisposition(file.name),
        "Content-Length": String(download.size),
      },
    });
  } catch (e) {
    if (isServiceError(e)) return notFoundResponse();
    throw e;
  }
}
