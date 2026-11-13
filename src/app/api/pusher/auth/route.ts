import { NextResponse } from "next/server";

import { getPusherServer } from "@/lib/pusher/server";
import { getOptionalUser } from "@/lib/tenant";
import { authorizeChatChannel } from "@/server/chat";

export const dynamic = "force-dynamic";

const SOCKET_ID = /^\d{1,20}\.\d{1,20}$/;

function deny(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Pusher private-channel authorisation. Signs ONLY "private-workspace-<id>"
 * for a signed-in user who is a member of that exact workspace (DB check).
 */
export async function POST(req: Request) {
  const pusher = getPusherServer();
  if (!pusher) return deny(404, "Gerçek zamanlı bağlantı yapılandırılmamış.");

  const user = await getOptionalUser();
  if (!user) return deny(403, "Oturum bulunamadı.");

  let socketId: string | null = null;
  let channelName: string | null = null;
  try {
    const params = new URLSearchParams(await req.text());
    socketId = params.get("socket_id");
    channelName = params.get("channel_name");
  } catch {
    return deny(403, "Geçersiz istek.");
  }
  if (!socketId || !SOCKET_ID.test(socketId)) return deny(403, "Geçersiz istek.");

  const decision = await authorizeChatChannel(user.id, channelName);
  if (!decision.allow) return deny(403, "Bu kanala erişiminiz yok.");

  try {
    const auth = pusher.authorizeChannel(socketId, channelName!);
    return NextResponse.json(auth, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return deny(403, "Geçersiz istek.");
  }
}
