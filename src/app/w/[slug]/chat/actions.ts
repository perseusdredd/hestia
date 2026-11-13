"use server";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import type { ChatMessageDTO } from "@/lib/pusher/chat-protocol";
import { publishChatDeletion, publishChatMessage } from "@/lib/pusher/server";
import { requireWorkspace } from "@/lib/tenant";
import { deleteMessage, sendChatMessage } from "@/server/chat";

/*
 * Chat writes. No revalidatePath here on purpose: the chat page keeps its own
 * client state (optimistic send + realtime/polling), and a router refresh
 * would only re-run the page query for nothing.
 */

/**
 * Send a message. Called directly (not via a <form>) so the composer can show
 * the message optimistically; `clientId` is a browser-generated id, stored on
 * the row so "Tekrar dene" after a lost response returns the same message
 * instead of a duplicate, and echoed in the realtime event so the sender can
 * reconcile. A retry that hit an existing row publishes nothing new.
 */
export async function sendChatMessageAction(
  slug: string,
  input: { body: string; clientId?: string },
): Promise<ActionState<ChatMessageDTO>> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const clientId = typeof input?.clientId === "string" && input.clientId !== "" ? input.clientId : undefined;
    const { message, created } = await sendChatMessage(ctx, { body: input?.body, clientId });
    if (created) await publishChatMessage(ctx.workspaceId, message, clientId);
    return { ok: true, data: message };
  } catch (e) {
    return toActionState<ChatMessageDTO>(e);
  }
}

/** Delete a message (author, or ADMIN/OWNER). useActionState-compatible. */
export async function deleteChatMessageAction(
  slug: string,
  _prev: ActionState<{ id: string }>,
  formData: FormData,
): Promise<ActionState<{ id: string }>> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const { id } = await deleteMessage(ctx, formString(formData, "id"));
    await publishChatDeletion(ctx.workspaceId, id);
    return { ok: true, message: "Mesaj silindi.", data: { id } };
  } catch (e) {
    return toActionState<{ id: string }>(e);
  }
}
