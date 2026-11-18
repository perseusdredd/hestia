"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { formFlag, formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import {
  createPost,
  deletePost,
  listPosts,
  publishPost,
  setPostPinned,
  updatePost,
  type PostListFilter,
  type PostListItem,
} from "@/server/messages";

function postValues(formData: FormData) {
  return {
    title: formString(formData, "title"),
    body: formString(formData, "body"),
    categoryId: formString(formData, "categoryId"),
    internal: formFlag(formData, "internal") ? "on" : "",
  };
}

/** Form strings -> service input (the checkbox becomes a boolean). */
function serviceInput(values: Record<string, string>) {
  return { ...values, internal: values.internal === "on" };
}

function revalidate(slug: string) {
  revalidatePath(`/w/${slug}/messages`, "layout");
}

export async function createPostAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { ...postValues(formData), projectId: formString(formData, "projectId") };
  const draft = formString(formData, "intent") === "draft";
  let postId: string;
  try {
    const { ctx } = await requireWorkspace(slug);
    postId = (await createPost(ctx, { ...serviceInput(values), draft })).id;
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
  const values = postValues(formData);
  try {
    const { ctx } = await requireWorkspace(slug);
    const id = formString(formData, "id");
    await updatePost(ctx, id, serviceInput(values));
    if (formString(formData, "intent") === "publish") {
      await publishPost(ctx, id);
      revalidate(slug);
      return { ok: true, message: "Gönderi yayınlandı.", values };
    }
    revalidate(slug);
    return { ok: true, message: "Gönderi güncellendi.", values };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function publishPostAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await publishPost(ctx, formString(formData, "id"));
    revalidate(slug);
    return { ok: true, message: "Gönderi yayınlandı." };
  } catch (e) {
    return toActionState(e);
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
  filter: PostListFilter = {},
): Promise<{ items: PostListItem[]; hasMore: boolean; nextCursor: string | null }> {
  const { ctx } = await requireWorkspace(slug);
  return listPosts(ctx, {
    cursor: typeof cursor === "string" ? cursor : "",
    categoryId: typeof filter?.categoryId === "string" ? filter.categoryId : null,
    draftsOnly: filter?.draftsOnly === true,
  });
}
