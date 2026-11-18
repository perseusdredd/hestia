"use server";

import { revalidatePath } from "next/cache";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import { toggleBookmark } from "@/server/bookmarks";

/**
 * Bookmark / un-bookmark a post, to-do, document or event for the caller. The
 * subject sent by the client is only a hint: the service validates it inside
 * the caller's workspace.
 */
export async function toggleBookmarkAction(
  slug: string,
  subjectType: string,
  subjectId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const want = formString(formData, "bookmarked") === "true";
  try {
    const { ctx } = await requireWorkspace(slug);
    await toggleBookmark(ctx, { type: subjectType, id: subjectId }, want);
    revalidatePath(`/w/${slug}`, "layout");
    return { ok: true, message: want ? "Yer imlerine eklendi." : "Yer imlerinden çıkarıldı." };
  } catch (e) {
    return toActionState(e);
  }
}
