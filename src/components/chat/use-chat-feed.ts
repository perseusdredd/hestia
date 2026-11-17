"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  completeChatImageUploadAction,
  sendChatMessageAction,
  startChatImageUploadAction,
} from "@/app/w/[slug]/chat/actions";
import {
  collectAfter,
  dropDeleted,
  maxCursor,
  mergeMessages,
  syncAfterCursor,
} from "@/components/chat/chat-utils";
import {
  pollingTransport,
  pusherTransport,
  type FeedSink,
  type TransportKind,
} from "@/components/chat/transports";
import type { ChatMessageDTO, ChatMessagesResponse } from "@/lib/pusher/chat-protocol";
import type { PublicRealtimeConfig } from "@/lib/pusher/client";

export type PendingMessage = {
  clientId: string;
  body: string;
  createdAt: Date;
  status: "sending" | "failed";
  error?: string;
};

/** Connection problems worth telling the user about. */
export type FeedProblem = "offline" | "signed-out" | "no-access" | null;

/** Deletion sync covers at most this many of the newest loaded messages. */
const LIVE_WINDOW = 200;

type FetchResult = { ok: true; data: ChatMessagesResponse } | { ok: false; problem: Exclude<FeedProblem, null> };

async function fetchMessages(slug: string, query: URLSearchParams, peerId?: string): Promise<FetchResult> {
  try {
    if (peerId) query.set("peer", peerId);
    const qs = query.toString();
    const res = await fetch(`/api/chat/${encodeURIComponent(slug)}/messages${qs ? `?${qs}` : ""}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      // The middleware redirects signed-out requests to /login; do not follow it.
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || res.status === 401) return { ok: false, problem: "signed-out" };
    if (res.status === 404) return { ok: false, problem: "no-access" };
    if (!res.ok) return { ok: false, problem: "offline" };
    return { ok: true, data: (await res.json()) as ChatMessagesResponse };
  } catch {
    return { ok: false, problem: "offline" };
  }
}

function newClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Chat state: confirmed messages (ascending, deduped by id), optimistic
 * pending sends (reconciled by clientId), older-page loading and a live
 * transport (Pusher when configured, polling otherwise or as a fallback).
 */
export function useChatFeed({
  slug,
  workspaceId,
  peerId,
  initialMessages,
  initialHasMore,
  realtime,
}: {
  peerId?: string;
  slug: string;
  workspaceId: string;
  initialMessages: ChatMessageDTO[];
  initialHasMore: boolean;
  realtime: PublicRealtimeConfig | null;
}) {
  const [messages, setMessages] = useState<ChatMessageDTO[]>(initialMessages);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [problem, setProblem] = useState<FeedProblem>(null);
  const [transportKind, setTransportKind] = useState<TransportKind>(realtime ? "pusher" : "polling");

  /** False once the server says we are no longer a member: the live transport is torn down. */
  const [live, setLive] = useState(true);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  /**
   * Newest cursor a sync RESPONSE returned. Only sync() advances it; the
   * sender's own message or a realtime event never does, so a message another
   * user sent just before ours is still fetched.
   */
  const serverCursorRef = useRef<string | null>(initialMessages.at(-1)?.cursor ?? null);
  /** Ids deleted while this page is open: late events or responses must not resurrect them. */
  const deletedIds = useRef(new Set<string>());

  const settle = useCallback((message: ChatMessageDTO, clientId?: string) => {
    if (clientId) setPending((p) => (p.some((x) => x.clientId === clientId) ? p.filter((x) => x.clientId !== clientId) : p));
    setMessages((cur) => mergeMessages(cur, [message], deletedIds.current));
  }, []);

  /** clientIds the server has confirmed as stored: never sent again. */
  const confirmedClientIds = useRef(new Set<string>());

  /**
   * Drop optimistic copies whose send the server already stored (e.g. the
   * action response was lost, so the item shows "failed"). Fetched rows carry
   * `clientId` only for the viewer's own messages.
   */
  const reconcile = useCallback((rows: ChatMessageDTO[]) => {
    const ids = new Set<string>();
    for (const m of rows) if (m.clientId) ids.add(m.clientId);
    if (ids.size === 0) return;
    ids.forEach((id) => confirmedClientIds.current.add(id));
    setPending((p) => (p.some((x) => ids.has(x.clientId)) ? p.filter((x) => !ids.has(x.clientId)) : p));
  }, []);

  const remove = useCallback((id: string) => {
    deletedIds.current.add(id);
    setMessages((cur) => (cur.some((m) => m.id === id) ? cur.filter((m) => m.id !== id) : cur));
  }, []);

  const syncOnce = useCallback(
    async (opts?: { deletions?: boolean }): Promise<boolean> => {
      const shown = messagesRef.current;
      const newest = shown.at(-1)?.cursor;
      const after = syncAfterCursor(serverCursorRef.current);
      const from =
        opts?.deletions && newest ? shown[Math.max(0, shown.length - LIVE_WINDOW)].cursor : undefined;
      const query = new URLSearchParams();
      if (after) query.set("after", after);
      if (after && from) query.set("from", from);

      const res = await fetchMessages(slug, query, peerId);
      if (!res.ok) {
        setProblem(res.problem);
        if (res.problem === "no-access") {
          // Removed from the workspace: stop listening and drop what we hold.
          setLive(false);
          setMessages([]);
          setPending([]);
        }
        return false;
      }
      const { data } = res;
      let fetched = data.messages;
      let truncated = false;
      if (after) {
        const all = await collectAfter(data, async (cursor) => {
          const r = await fetchMessages(slug, new URLSearchParams({ after: cursor }), peerId);
          return r.ok ? r.data : null;
        });
        if (!all) {
          setProblem("offline");
          return false;
        }
        fetched = all.messages;
        truncated = all.truncated;
      }
      setProblem(null);

      if (truncated) {
        // Too far behind to page through: restart from the newest page and let
        // "load older" fill the history.
        const page = await fetchMessages(slug, new URLSearchParams(), peerId);
        if (!page.ok) return false;
        serverCursorRef.current = maxCursor(null, page.data.messages.at(-1)?.cursor);
        setMessages(page.data.messages.filter((m) => !deletedIds.current.has(m.id)));
        reconcile(page.data.messages);
        setHasMore(true);
        return true;
      }

      serverCursorRef.current = maxCursor(serverCursorRef.current, fetched.at(-1)?.cursor);
      setMessages((cur) => {
        let next = mergeMessages(cur, fetched, deletedIds.current);
        if (from && newest && data.liveIds && data.liveIdsComplete) {
          next = dropDeleted(next, data.liveIds, from, newest);
        }
        return next;
      });
      reconcile(fetched);
      // Nothing synced before: the "newest page" answer also says whether older pages exist.
      if (!after && typeof data.hasMore === "boolean") setHasMore(data.hasMore);
      return true;
    },
    [slug, peerId, reconcile],
  );

  /** Coalesces overlapping calls (every realtime event asks for a sync). */
  const syncState = useRef<{ running: Promise<boolean> | null; again: boolean; deletions: boolean }>({
    running: null,
    again: false,
    deletions: false,
  });
  const sync = useCallback(
    (opts?: { deletions?: boolean }): Promise<boolean> => {
      const st = syncState.current;
      if (st.running) {
        st.again = true;
        st.deletions ||= Boolean(opts?.deletions);
        return st.running;
      }
      const run = async (o?: { deletions?: boolean }): Promise<boolean> => {
        let ok = await syncOnce(o);
        while (st.again) {
          const deletions = st.deletions;
          st.again = false;
          st.deletions = false;
          ok = await syncOnce({ deletions });
        }
        return ok;
      };
      st.running = run(opts).finally(() => {
        st.running = null;
      });
      return st.running;
    },
    [syncOnce],
  );

  const fallback = useCallback(() => setTransportKind("polling"), []);

  const sinkRef = useRef<FeedSink>({ receive: settle, remove, sync, fallback });
  sinkRef.current = { receive: settle, remove, sync, fallback };

  useEffect(() => {
    if (!live) return;
    const transport =
      transportKind === "pusher" && realtime ? pusherTransport(realtime, workspaceId) : pollingTransport();
    // Indirection so the transport always calls the latest callbacks.
    const sink: FeedSink = {
      receive: (m, c) => sinkRef.current.receive(m, c),
      remove: (id) => sinkRef.current.remove(id),
      sync: (o) => sinkRef.current.sync(o),
      fallback: () => sinkRef.current.fallback(),
    };
    return transport.start(sink);
  }, [live, transportKind, realtime, workspaceId]);

  /** Loads the page before the oldest shown message. Resolves true when rows were prepended. */
  const loadOlder = useCallback(async (): Promise<boolean> => {
    const oldest = messagesRef.current[0]?.cursor;
    if (!oldest || loadingOlder) return false;
    setLoadingOlder(true);
    setOlderError(null);
    const res = await fetchMessages(slug, new URLSearchParams({ before: oldest }), peerId);
    setLoadingOlder(false);
    if (!res.ok) {
      setOlderError(
        res.problem === "offline" ? "Eski mesajlar yüklenemedi. Tekrar deneyin." : "Mesajlara erişilemiyor.",
      );
      return false;
    }
    const older = res.data.messages.filter((m) => !deletedIds.current.has(m.id));
    setMessages((cur) => mergeMessages(cur, older, deletedIds.current));
    reconcile(res.data.messages);
    setHasMore(Boolean(res.data.hasMore));
    return older.length > 0;
  }, [slug, peerId, loadingOlder, reconcile]);

  const deliver = useCallback(
    async (clientId: string, body: string) => {
      try {
        const res = await sendChatMessageAction(slug, { body, clientId, peerId });
        if (res.ok && res.data) {
          confirmedClientIds.current.add(clientId);
          settle(res.data, clientId);
          return;
        }
        const error = res.error ?? "Mesaj gönderilemedi.";
        setPending((p) => p.map((x) => (x.clientId === clientId ? { ...x, status: "failed", error } : x)));
      } catch {
        setPending((p) =>
          p.map((x) =>
            x.clientId === clientId
              ? { ...x, status: "failed", error: "Bağlantı sorunu nedeniyle gönderilemedi." }
              : x,
          ),
        );
      }
    },
    [slug, peerId, settle],
  );

  const send = useCallback(
    (body: string) => {
      const clientId = newClientId();
      setPending((p) => [...p, { clientId, body, createdAt: new Date(), status: "sending" }]);
      void deliver(clientId, body);
    },
    [deliver],
  );

  const retry = useCallback(
    (clientId: string) => {
      const item = pending.find((x) => x.clientId === clientId);
      if (!item) return;
      if (confirmedClientIds.current.has(clientId)) {
        // Already stored (and maybe deleted since): resending would re-insert it.
        setPending((p) => p.filter((x) => x.clientId !== clientId));
        return;
      }
      setPending((p) =>
        p.map((x) => (x.clientId === clientId ? { ...x, status: "sending", error: undefined } : x)),
      );
      void deliver(clientId, item.body);
    },
    [pending, deliver],
  );

  const discard = useCallback((clientId: string) => {
    setPending((p) => p.filter((x) => x.clientId !== clientId));
  }, []);

  const [sendingImage, setSendingImage] = useState(false);

  /**
   * Photo send: upload (start, PUT, complete), then post a message that
   * references the stored file. Not optimistic: the caller shows progress and
   * keeps the picked photo until this resolves.
   */
  const sendImage = useCallback(
    async (file: File, caption: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      setSendingImage(true);
      try {
        const started = await startChatImageUploadAction(slug, { name: file.name, size: file.size, type: file.type });
        if (!started.ok || !started.data) return { ok: false, error: started.error ?? "Fotoğraf yüklenemedi." };
        const target = started.data;
        const put = await fetch(target.url, { method: target.method, headers: target.headers, body: file });
        if (!put.ok) return { ok: false, error: "Fotoğraf yüklenemedi. Lütfen tekrar deneyin." };
        const done = await completeChatImageUploadAction(slug, target.token);
        if (!done.ok || !done.data) return { ok: false, error: done.error ?? "Fotoğraf yüklenemedi." };
        const clientId = newClientId();
        const res = await sendChatMessageAction(slug, { body: caption, clientId, fileId: done.data.id, peerId });
        if (res.ok && res.data) {
          confirmedClientIds.current.add(clientId);
          settle(res.data, clientId);
          return { ok: true };
        }
        return { ok: false, error: res.error ?? "Mesaj gönderilemedi." };
      } catch {
        return { ok: false, error: "Bağlantı sorunu nedeniyle gönderilemedi." };
      } finally {
        setSendingImage(false);
      }
    },
    [slug, peerId, settle],
  );

  return useMemo(
    () => ({
      messages,
      pending,
      hasMore,
      loadingOlder,
      olderError,
      problem,
      transportKind,
      loadOlder,
      send,
      sendImage,
      sendingImage,
      retry,
      discard,
      remove,
    }),
    [messages, pending, hasMore, loadingOlder, olderError, problem, transportKind, loadOlder, send, sendImage, sendingImage, retry, discard, remove],
  );
}
