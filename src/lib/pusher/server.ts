import "server-only";

import Pusher from "pusher";

import { CHAT_EVENTS, workspaceChannel } from "@/lib/pusher/channels";
import type { ChatDeleteEvent, ChatMessageDTO, ChatMessageEvent } from "@/lib/pusher/chat-protocol";

/** Public settings the browser needs; null when realtime is not configured. */
export type RealtimeConfig = { key: string; cluster: string } | null;

function readEnv() {
  const appId = process.env.PUSHER_APP_ID?.trim();
  const secret = process.env.PUSHER_SECRET?.trim();
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY?.trim();
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER?.trim() || "eu";
  if (!appId || !secret || !key) return null;
  return { appId, secret, key, cluster };
}

/** Pusher is used only when ALL server + public credentials are present. */
export function getRealtimeConfig(): RealtimeConfig {
  const env = readEnv();
  return env ? { key: env.key, cluster: env.cluster } : null;
}

const globalForPusher = globalThis as unknown as { __hestiaPusher?: Pusher | null };

export function getPusherServer(): Pusher | null {
  if (globalForPusher.__hestiaPusher !== undefined) return globalForPusher.__hestiaPusher;
  const env = readEnv();
  const client = env
    ? new Pusher({ appId: env.appId, key: env.key, secret: env.secret, cluster: env.cluster, useTLS: true })
    : null;
  globalForPusher.__hestiaPusher = client;
  return client;
}

/**
 * Fan-out after a successful DB write. Never throws: realtime is best effort
 * (clients resync on reconnect, and the DB is the source of truth).
 */
async function trigger(workspaceId: string, event: string, data: unknown): Promise<void> {
  const pusher = getPusherServer();
  if (!pusher) return;
  try {
    await pusher.trigger(workspaceChannel(workspaceId), event, data);
  } catch (e) {
    console.error("[pusher] trigger failed", event, e instanceof Error ? e.message : e);
  }
}

/**
 * Announces a new message by reference only (see ChatMessageEvent): the
 * content never goes over the shared channel.
 */
export async function publishChatMessage(
  workspaceId: string,
  message: Pick<ChatMessageDTO, "id" | "cursor">,
  clientId?: string,
): Promise<void> {
  const payload: ChatMessageEvent = { kind: "ref", id: message.id, cursor: message.cursor, clientId };
  await trigger(workspaceId, CHAT_EVENTS.message, payload);
}

export async function publishChatDeletion(workspaceId: string, id: string): Promise<void> {
  const payload: ChatDeleteEvent = { id };
  await trigger(workspaceId, CHAT_EVENTS.deleted, payload);
}
