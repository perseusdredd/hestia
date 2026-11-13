/**
 * Swappable realtime transports for the chat feed. A transport only tells the
 * feed WHAT happened; the feed owns the state and dedupes everything by id,
 * so both paths (and any overlap while switching) are safe.
 */
import { CHAT_EVENTS, workspaceChannel } from "@/lib/pusher/channels";
import type { ChatDeleteEvent, ChatMessageDTO, ChatMessageEvent } from "@/lib/pusher/chat-protocol";
import { getPusherClient, type PublicRealtimeConfig } from "@/lib/pusher/client";

export type TransportKind = "pusher" | "polling";

export type FeedSink = {
  /** A full message from the server; `clientId` is set for the sender's own optimistic copy. */
  receive(message: ChatMessageDTO, clientId?: string): void;
  /** A message was deleted. */
  remove(id: string): void;
  /** Fetch everything newer than what is shown (optionally also sync deletions). Resolves false on failure. */
  sync(opts?: { deletions?: boolean }): Promise<boolean>;
  /** This transport cannot work here (e.g. channel auth refused): switch to polling. */
  fallback(): void;
};

export type FeedTransport = {
  kind: TransportKind;
  /** Starts listening; returns the stop function. */
  start(sink: FeedSink): () => void;
};

export function pusherTransport(config: PublicRealtimeConfig, workspaceId: string): FeedTransport {
  return {
    kind: "pusher",
    start(sink) {
      let stopped = false;
      let stop = () => {};

      getPusherClient(config)
        .then((pusher) => {
          if (stopped) return;
          const name = workspaceChannel(workspaceId);
          const channel = pusher.subscribe(name);

          // Events carry only a reference: fetch the content over the
          // membership-checked HTTP route.
          const onMessage = (ev: ChatMessageEvent) => {
            if (ev?.kind === "ref") void sink.sync();
          };
          const onDeleted = (ev: ChatDeleteEvent) => {
            if (typeof ev?.id === "string") sink.remove(ev.id);
          };
          // Fires on the first subscribe and after every reconnect: catch up on anything missed.
          const onSubscribed = () => void sink.sync({ deletions: true });
          const onSubscribeError = () => sink.fallback();
          const onState = ({ current }: { current: string }) => {
            if (current === "failed") sink.fallback();
          };

          channel.bind(CHAT_EVENTS.message, onMessage);
          channel.bind(CHAT_EVENTS.deleted, onDeleted);
          channel.bind("pusher:subscription_succeeded", onSubscribed);
          channel.bind("pusher:subscription_error", onSubscribeError);
          pusher.connection.bind("state_change", onState);

          stop = () => {
            channel.unbind(CHAT_EVENTS.message, onMessage);
            channel.unbind(CHAT_EVENTS.deleted, onDeleted);
            channel.unbind("pusher:subscription_succeeded", onSubscribed);
            channel.unbind("pusher:subscription_error", onSubscribeError);
            pusher.connection.unbind("state_change", onState);
            pusher.unsubscribe(name);
          };
        })
        .catch(() => {
          if (!stopped) sink.fallback();
        });

      return () => {
        stopped = true;
        stop();
      };
    },
  };
}

export const POLL_INTERVAL_MS = 3000;
const MAX_POLL_INTERVAL_MS = 30_000;

/** GET /api/chat/[slug]/messages?after=... every ~3 s while the tab is visible. */
export function pollingTransport(intervalMs = POLL_INTERVAL_MS): FeedTransport {
  return {
    kind: "polling",
    start(sink) {
      let stopped = false;
      let running = false;
      let delay = intervalMs;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const tick = async () => {
        if (stopped || running || document.visibilityState === "hidden") return;
        running = true;
        try {
          const ok = await sink.sync({ deletions: true });
          // Back off while the server is unreachable, snap back once it answers.
          delay = ok ? intervalMs : Math.min(delay * 2, MAX_POLL_INTERVAL_MS);
        } finally {
          running = false;
        }
      };

      const schedule = () => {
        timer = setTimeout(async () => {
          await tick();
          if (!stopped) schedule();
        }, delay);
      };

      const onVisibility = () => {
        if (document.visibilityState === "visible") void tick();
      };

      document.addEventListener("visibilitychange", onVisibility);
      void tick();
      schedule();

      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
  };
}
