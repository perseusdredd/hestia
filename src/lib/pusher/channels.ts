/**
 * Channel + event names shared by the server and the browser. Pure module:
 * no secrets, no Node or Next imports.
 */

export const WORKSPACE_CHANNEL_PREFIX = "private-workspace-";

/** Workspace ids are cuids: lowercase letters and digits. */
const WORKSPACE_ID_PATTERN = /^[a-z0-9]{1,64}$/;

export const CHAT_EVENTS = {
  /** A new message. Payload: ChatMessageEvent. */
  message: "chat-message",
  /** A message was deleted. Payload: ChatDeleteEvent. */
  deleted: "chat-message-deleted",
} as const;

/** Pusher rejects event payloads over 10 KB; stay well below it. */
export const MAX_EVENT_BYTES = 9_000;

export function workspaceChannel(workspaceId: string): string {
  return `${WORKSPACE_CHANNEL_PREFIX}${workspaceId}`;
}

/**
 * Extracts the workspace id from "private-workspace-<id>". Returns null for
 * anything else (other prefixes, extra segments, wrong characters, too long).
 */
export function parseWorkspaceChannel(channelName: unknown): string | null {
  if (typeof channelName !== "string" || channelName.length > 128) return null;
  if (!channelName.startsWith(WORKSPACE_CHANNEL_PREFIX)) return null;
  const id = channelName.slice(WORKSPACE_CHANNEL_PREFIX.length);
  return WORKSPACE_ID_PATTERN.test(id) ? id : null;
}
