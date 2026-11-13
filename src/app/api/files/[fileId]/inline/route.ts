import { NextResponse } from "next/server";

import { getOptionalUser } from "@/lib/tenant";
import { isServiceError } from "@/server/errors";
import { authorizeFileAccess, getFileInline } from "@/server/files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Headers for every non-body answer (errors, redirects). */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
} as const;

function errorResponse(status: number, error: string, extra: Record<string, string> = {}) {
  return NextResponse.json({ error }, { status, headers: { ...SECURITY_HEADERS, ...extra } });
}

/**
 * Inline view of an allow-listed, magic-number-verified file (images, PDF,
 * audio, video). Same access rules as the download route: signed-out -> 401,
 * unknown file or not a member -> 404. Not previewable -> 415.
 */
export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  const user = await getOptionalUser();
  if (!user) return errorResponse(401, "Oturum bulunamadı.");

  const ctx = await authorizeFileAccess(user.id, fileId);
  if (!ctx) return errorResponse(404, "Dosya bulunamadı.");

  try {
    const result = await getFileInline(ctx, fileId, { range: req.headers.get("range") });
    if (result.kind === "redirect") {
      return new NextResponse(null, { status: 302, headers: { ...SECURITY_HEADERS, Location: result.url } });
    }
    if (result.kind === "unsatisfiable") {
      return errorResponse(416, "İstenen aralık geçersiz.", { "Content-Range": `bytes */${result.size}` });
    }
    return new NextResponse(result.body, { status: result.status, headers: result.headers });
  } catch (e) {
    if (isServiceError(e)) {
      return e.code === "VALIDATION" ? errorResponse(415, e.message) : errorResponse(404, "Dosya bulunamadı.");
    }
    throw e;
  }
}
