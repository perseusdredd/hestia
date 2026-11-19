"use server";

import { revalidatePath } from "next/cache";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import { toggleReaction } from "@/server/reactions";

/**
 * Toggle the caller's emoji reaction on a post, comment, chat message, to-do, document or event. The subject sent
 * by the client is only a hint: the service validates it inside the caller's
 * workspace.
 */
export async function toggleReactionAction(
  slug: string,
  subjectType: string,
  subjectId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await toggleReaction(ctx, { type: subjectType, id: subjectId }, formString(formData, "emoji"));
    // A comment can sit on a post, to-do, document or event page.
    revalidatePath(`/w/${slug}`, "layout");
    return { ok: true };
  } catch (e) {
    return toActionState(e);
  }
}
