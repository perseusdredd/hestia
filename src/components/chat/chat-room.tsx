"use client";

import { ArrowDown, Loader2, MessagesSquare, WifiOff } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { groupFeed, type FeedItem } from "@/components/chat/chat-utils";
import { ChatComposer } from "@/components/chat/composer";
import { DeleteMessageDialog } from "@/components/chat/delete-message-dialog";
import { MessageFeed } from "@/components/chat/message-feed";
import { useChatFeed } from "@/components/chat/use-chat-feed";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import type { ChatAuthor, ChatMessageDTO } from "@/lib/pusher/chat-protocol";
import type { PublicRealtimeConfig } from "@/lib/pusher/client";
import { hasRole, type Role } from "@/lib/roles";

/** Distance from the bottom (px) that still counts as "at the bottom". */
const STICK_THRESHOLD = 80;

const noopSubscribe = () => () => {};

/** False during SSR + hydration: times/day labels depend on the viewer's time zone. */
function useIsClient() {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function ChatRoom({
  slug,
  workspaceId,
  peerId,
  peerName,
  me,
  initialMessages,
  initialHasMore,
  realtime,
}: {
  slug: string;
  workspaceId: string;
  /** Set for a direct-message conversation; absent for the public room. */
  peerId?: string;
  peerName?: string;
  me: ChatAuthor & { role: Role };
  initialMessages: ChatMessageDTO[];
  initialHasMore: boolean;
  realtime: PublicRealtimeConfig | null;
}) {
  const feed = useChatFeed({ slug, workspaceId, peerId, initialMessages, initialHasMore, realtime });
  const isClient = useIsClient();
  const [deleteTarget, setDeleteTarget] = useState<FeedItem | null>(null);
  const [unseen, setUnseen] = useState(0);
  // Screen-reader announcement for messages from others (the feed itself is
  // not a live region: prepending older pages would be read out too).
  const [announcement, setAnnouncement] = useState("");

  const scrollerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  /** Snapshot taken right before older messages are prepended. */
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const seenRef = useRef<{ keys: Set<string>; ids: Set<string>; newest: number } | null>(null);
  const firstKeyRef = useRef<string | null>(null);

  const items = useMemo<FeedItem[]>(() => {
    const sent: FeedItem[] = feed.messages.map((m) => ({
      key: m.id,
      id: m.id,
      body: m.body,
      image: m.image ? { id: m.image.id, name: m.image.name } : undefined,
      createdAt: new Date(m.createdAt),
      author: m.author,
      status: "sent",
    }));
    const local: FeedItem[] = feed.pending.map((p) => ({
      key: `local-${p.clientId}`,
      id: null,
      body: p.body,
      createdAt: p.createdAt,
      author: me,
      status: p.status,
      error: p.error,
      clientId: p.clientId,
    }));
    return [...sent, ...local];
  }, [feed.messages, feed.pending, me]);

  const rows = useMemo(() => (isClient ? groupFeed(items) : []), [items, isClient]);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollerRef.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? "smooth" : "auto" });
    atBottomRef.current = true;
    setUnseen(0);
  }, []);

  // Keep the viewport where the user expects it after every list change.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !isClient) return;

    const firstKey = items[0]?.key ?? null;
    const previousFirst = firstKeyRef.current;
    firstKeyRef.current = firstKey;
    const previous = seenRef.current;
    seenRef.current = {
      keys: new Set(items.map((i) => i.key)),
      ids: new Set(items.flatMap((i) => [i.id, i.clientId].filter((v): v is string => Boolean(v)))),
      newest: items.reduce((t, i) => Math.max(t, i.createdAt.getTime()), 0),
    };

    const anchor = anchorRef.current;
    if (anchor && previousFirst !== null && firstKey !== previousFirst) {
      // Older page was prepended: keep the same message under the user's eyes.
      anchorRef.current = null;
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
      return;
    }

    if (!previous) {
      scrollToBottom();
      return;
    }

    // Items that were not on screen before and are not older than what was shown.
    const arrived = items.filter(
      (i) =>
        !previous.keys.has(i.key) &&
        !(i.clientId && previous.ids.has(i.clientId)) &&
        i.createdAt.getTime() >= previous.newest - 1000,
    );
    if (arrived.length === 0) return;

    const fromOthers = arrived.filter((i) => i.author.id !== me.id);
    if (fromOthers.length > 0) {
      const last = fromOthers[fromOthers.length - 1];
      const who = last.author.name?.trim() || last.author.email;
      setAnnouncement(
        fromOthers.length === 1
          ? `Yeni mesaj, ${who}: ${last.body.slice(0, 200)}`
          : `${fromOthers.length} yeni mesaj. Son mesaj, ${who}: ${last.body.slice(0, 200)}`,
      );
    }

    // Follow new messages if the user is at the bottom or sent one of them.
    const mine = arrived.some((i) => i.author.id === me.id);
    if (atBottomRef.current || mine) {
      scrollToBottom();
    } else {
      setUnseen((n) => n + arrived.length);
    }
  }, [items, isClient, me.id, scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    atBottomRef.current = atBottom;
    if (atBottom) setUnseen(0);
  }, []);

  const loadOlder = useCallback(() => {
    const el = scrollerRef.current;
    if (el) anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
    void feed.loadOlder().then((prepended) => {
      // Nothing was prepended (error / no rows): drop the snapshot.
      if (!prepended) anchorRef.current = null;
    });
  }, [feed]);

  // Admins moderate the public room only; a direct message is deleted by its author.
  const isAdmin = !peerId && hasRole(me.role, "ADMIN");
  const canDelete = useCallback((item: FeedItem) => isAdmin || item.author.id === me.id, [isAdmin, me.id]);
  // A photo that finishes loading grows the list: keep the newest message in view.
  const onImageLoad = useCallback(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);
  const closeDelete = useCallback(() => setDeleteTarget(null), []);

  const empty = items.length === 0;

  return (
    <section
      aria-label="Ekip sohbeti"
      className="relative flex h-[calc(100dvh-15rem)] min-h-96 flex-col overflow-hidden rounded-xl border bg-card md:h-[calc(100dvh-13rem)]"
    >
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 sm:px-5"
        // Scrollable with the keyboard even when it holds no buttons.
        tabIndex={0}
        role="region"
        aria-label="Mesaj geçmişi"
      >
        {!isClient ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
            Mesajlar yükleniyor…
          </div>
        ) : empty ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={MessagesSquare}
              title="Henüz mesaj yok"
              description={
                peerId
                  ? `${peerName ?? "Bu kişi"} ile özel sohbetiniz. Yazdıklarınızı yalnızca siz ikiniz görürsünüz.`
                  : "İlk mesajı yazarak ekip sohbetini başlatın. Çalışma alanındaki herkes burada yazılanları görür."
              }
              className="w-full max-w-md border-none"
            />
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center gap-1 pb-2">
              {feed.hasMore ? (
                <Button type="button" variant="outline" size="sm" onClick={loadOlder} disabled={feed.loadingOlder}>
                  {feed.loadingOlder ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {feed.loadingOlder ? "Yükleniyor…" : "Daha eski mesajları yükle"}
                </Button>
              ) : (
                <p className="py-2 text-xs text-muted-foreground">Sohbetin başlangıcı</p>
              )}
              {feed.olderError ? (
                <p role="alert" className="text-xs text-destructive">
                  {feed.olderError}
                </p>
              ) : null}
            </div>
            <MessageFeed
              rows={rows}
              canDelete={canDelete}
              onImageLoad={onImageLoad}
              onDelete={setDeleteTarget}
              onRetry={feed.retry}
              onDiscard={feed.discard}
            />
          </>
        )}
      </div>

      {unseen > 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 flex justify-center">
          <Button
            type="button"
            size="sm"
            className="pointer-events-auto rounded-full shadow-md"
            onClick={() => scrollToBottom(true)}
          >
            <ArrowDown aria-hidden />
            {unseen === 1 ? "Yeni mesaj" : `${unseen} yeni mesaj`}
          </Button>
        </div>
      ) : null}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {feed.problem ? <ProblemBanner problem={feed.problem} /> : null}

      <ChatComposer
        direct={Boolean(peerId)}
        onSend={feed.send}
        onSendImage={feed.sendImage}
        sendingImage={feed.sendingImage}
        disabled={feed.problem === "signed-out" || feed.problem === "no-access"}
      />

      {deleteTarget?.id ? (
        <DeleteMessageDialog
          key={deleteTarget.id}
          slug={slug}
          messageId={deleteTarget.id}
          preview={deleteTarget.body || "Fotoğraf"}
          onClose={closeDelete}
          onDeleted={feed.remove}
        />
      ) : null}
    </section>
  );
}

function ProblemBanner({ problem }: { problem: NonNullable<ReturnType<typeof useChatFeed>["problem"]> }) {
  const text =
    problem === "signed-out"
      ? "Oturumunuz sona ermiş. Devam etmek için sayfayı yenileyip tekrar giriş yapın."
      : problem === "no-access"
        ? "Bu çalışma alanına artık erişiminiz yok."
        : "Bağlantı sorunu. Yeni mesajlar için yeniden deneniyor…";
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-t bg-muted/60 px-4 py-2 text-xs text-muted-foreground"
    >
      <WifiOff className="size-3.5 shrink-0" aria-hidden />
      {text}
    </div>
  );
}
