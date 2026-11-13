"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import {
  createPost,
  deletePost,
  listPosts,
  setPostPinned,
  updatePost,
  type PostListItem,
} from "@/server/messages";

function revalidate(slug: string) {
  revalidatePath(`/w/${slug}/messages`, "layout");
}

export async function createPostAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { title: formString(formData, "title"), body: formString(formData, "body") };
  let postId: string;
  try {
    const { ctx } = await requireWorkspace(slug);
    postId = (await createPost(ctx, values)).id;
    revalidate(slug);
  } catch (e) {
    return { ...toActionState(e), values };
  }
  redirect(`/w/${slug}/messages/${postId}`);
}

export async function updatePostAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { title: formString(formData, "title"), body: formString(formData, "body") };
  try {
    const { ctx } = await requireWorkspace(slug);
    await updatePost(ctx, formString(formData, "id"), values);
    revalidate(slug);
    return { ok: true, message: "Gönderi güncellendi.", values };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function deletePostAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await deletePost(ctx, formString(formData, "id"));
    revalidate(slug);
  } catch (e) {
    return toActionState(e);
  }
  redirect(`/w/${slug}/messages`);
}

export async function togglePinAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const pinned = formString(formData, "pinned") === "true";
    await setPostPinned(ctx, formString(formData, "id"), pinned);
    revalidate(slug);
    return { ok: true, message: pinned ? "Gönderi sabitlendi." : "Sabitleme kaldırıldı." };
  } catch (e) {
    return toActionState(e);
  }
}

/** Load-more for the list. Re-checks membership itself; the cursor is validated by the service. */
export async function loadMorePostsAction(
  slug: string,
  cursor: string,
): Promise<{ items: PostListItem[]; hasMore: boolean; nextCursor: string | null }> {
  const { ctx } = await requireWorkspace(slug);
  return listPosts(ctx, { cursor: typeof cursor === "string" ? cursor : "" });
}
