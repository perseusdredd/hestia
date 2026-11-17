"use server";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import type { ChatMessageDTO } from "@/lib/pusher/chat-protocol";
import { publishChatDeletion, publishChatMessage } from "@/lib/pusher/server";
import { requireWorkspace } from "@/lib/tenant";
import { deleteMessage, sendChatMessage } from "@/server/chat";
import { completeUpload, createChatImageUpload, type PendingUpload } from "@/server/files";

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
  input: { body: string; clientId?: string; fileId?: string },
): Promise<ActionState<ChatMessageDTO>> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const clientId = typeof input?.clientId === "string" && input.clientId !== "" ? input.clientId : undefined;
    const fileId = typeof input?.fileId === "string" && input.fileId !== "" ? input.fileId : undefined;
    const { message, created } = await sendChatMessage(ctx, { body: input?.body ?? "", clientId, fileId });
    if (created) await publishChatMessage(ctx.workspaceId, message, clientId);
    return { ok: true, data: message };
  } catch (e) {
    return toActionState<ChatMessageDTO>(e);
  }
}

/** Photo upload step 1: validate (image type, <= 10 MB) and return where to PUT the bytes. */
export async function startChatImageUploadAction(
  slug: string,
  input: { name: string; size: number; type: string },
): Promise<ActionState<PendingUpload>> {
  try {
    const { ctx } = await requireWorkspace(slug);
    return { ok: true, data: await createChatImageUpload(ctx, input) };
  } catch (e) {
    return toActionState<PendingUpload>(e);
  }
}

/** Photo upload step 3: verify the stored object and create its (hidden) File row. */
export async function completeChatImageUploadAction(
  slug: string,
  token: string,
): Promise<ActionState<{ id: string }>> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const file = await completeUpload(ctx, token);
    return { ok: true, data: { id: file.id } };
  } catch (e) {
    return toActionState<{ id: string }>(e);
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
