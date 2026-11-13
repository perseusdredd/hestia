import type { Metadata } from "next";

import { ChatRoom } from "@/components/chat/chat-room";
import { PageHeader } from "@/components/page-header";
import { getRealtimeConfig } from "@/lib/pusher/server";
import { requireWorkspace } from "@/lib/tenant";
import { listMessages } from "@/server/chat";

export const metadata: Metadata = { title: "Sohbet" };
export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { user, workspace, ctx } = await requireWorkspace(slug);
  const [{ messages, hasMore }, realtime] = await Promise.all([listMessages(ctx), getRealtimeConfig()]);

  return (
    <div className="space-y-4">
      <PageHeader title="Sohbet" description={`${workspace.name} ekibinin ortak sohbet odası.`} />
      <ChatRoom
        slug={workspace.slug}
        workspaceId={workspace.id}
        me={{ id: user.id, name: user.name, email: user.email, image: user.image, role: ctx.role }}
        initialMessages={messages}
        initialHasMore={hasMore}
        realtime={realtime}
      />
    </div>
  );
}
