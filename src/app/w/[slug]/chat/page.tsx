import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ChatRoom } from "@/components/chat/chat-room";
import { PageHeader } from "@/components/page-header";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { getRealtimeConfig } from "@/lib/pusher/server";
import { isGuest } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { getPeer, listConversations, listMessages } from "@/server/chat";
import { isServiceError } from "@/server/errors";
import { markDmRead } from "@/server/notifications";
import { listReactions, REACTION_EMOJIS } from "@/server/reactions";

export const metadata: Metadata = { title: "Sohbet" };
export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ with?: string }>;
}) {
  const { slug } = await params;
  const { with: withParam } = await searchParams;
  const peerId = typeof withParam === "string" && withParam !== "" ? withParam : undefined;
  const { user, workspace, ctx } = await requireWorkspace(slug);
  if (isGuest(ctx.role)) notFound(); // team-only page

  let peer: Awaited<ReturnType<typeof getPeer>> = null;
  if (peerId) {
    try {
      peer = await getPeer(ctx, peerId);
    } catch (e) {
      if (isServiceError(e)) notFound();
      throw e;
    }
    if (!peer) notFound();
    await markDmRead(ctx, peerId);
  }

  const [{ messages, hasMore }, realtime, conversations] = await Promise.all([
    listMessages(ctx, peerId ? { peer: peerId } : {}),
    getRealtimeConfig(),
    listConversations(ctx),
  ]);
  const reactions = await listReactions(
    ctx,
    "chatMessage",
    messages.map((m) => m.id),
  );
  const base = `/w/${workspace.slug}/chat`;
  const tab = "flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm min-h-10";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sohbet"
        description={
          peer
            ? `${displayName(peer)} ile özel sohbet.`
            : `${workspace.name} ekibinin ortak sohbet odası ve doğrudan mesajlar.`
        }
      />
      <nav aria-label="Sohbetler" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        <Link
          href={base}
          aria-current={!peer ? "page" : undefined}
          className={cn(tab, !peer ? "border-primary bg-primary text-primary-foreground" : "bg-card")}
        >
          Ekip sohbeti
        </Link>
        {conversations.map((c) => {
          const active = peer?.id === c.userId;
          return (
            <Link
              key={c.userId}
              href={`${base}?with=${c.userId}`}
              aria-current={active ? "page" : undefined}
              className={cn(tab, active ? "border-primary bg-primary text-primary-foreground" : "bg-card")}
            >
              <UserAvatar user={c} size="sm" />
              <span>{displayName(c)}</span>
              {c.unread && !active ? (
                <span className="size-2 rounded-full bg-primary" role="img" aria-label="Okunmamış mesaj" />
              ) : null}
            </Link>
          );
        })}
      </nav>
      <ChatRoom
        key={peerId ?? "room"}
        slug={workspace.slug}
        workspaceId={workspace.id}
        peerId={peer?.id}
        peerName={peer ? displayName(peer) : undefined}
        me={{ id: user.id, name: user.name, email: user.email, image: user.image, role: ctx.role }}
        initialMessages={messages}
        initialHasMore={hasMore}
        realtime={realtime}
        reactions={reactions}
        allowedReactions={REACTION_EMOJIS}
      />
    </div>
  );
}
