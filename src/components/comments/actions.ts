"use server";

import { revalidatePath } from "next/cache";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import {
  addComment,
  commentSubjectOf,
  deleteComment,
  updateComment,
  type CommentSubject,
} from "@/server/comments";

/**
 * Server actions of the shared comment thread (posts, to-dos, documents,
 * events). The subject type/id bound on the client are only hints: the
 * service validates them and loads the subject inside the caller's workspace,
 * and revalidation uses the subject the service returned.
 */

function revalidateSubject(slug: string, subject: CommentSubject | null) {
  if (!subject) return;
  switch (subject.type) {
    case "post":
      revalidatePath(`/w/${slug}/messages`, "layout");
      break;
    case "todo":
      revalidatePath(`/w/${slug}/todos`, "layout");
      break;
    case "document":
      revalidatePath(`/w/${slug}/files/docs/${subject.id}`);
      break;
    case "event":
      revalidatePath(`/w/${slug}/calendar`, "layout");
      break;
    case "file":
      revalidatePath(`/w/${slug}/files`, "layout");
      break;
  }
}

export async function addCommentAction(
  slug: string,
  subjectType: string,
  subjectId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { body: formString(formData, "body") };
  try {
    const { ctx } = await requireWorkspace(slug);
    const comment = await addComment(ctx, { type: subjectType, id: subjectId } as CommentSubject, values);
    revalidateSubject(slug, commentSubjectOf(comment));
    return { ok: true, message: "Yorum eklendi." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function updateCommentAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { body: formString(formData, "body") };
  try {
    const { ctx } = await requireWorkspace(slug);
    const { subject } = await updateComment(ctx, formString(formData, "id"), values);
    revalidateSubject(slug, subject);
    return { ok: true, message: "Yorum güncellendi.", values };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function deleteCommentAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const { subject } = await deleteComment(ctx, formString(formData, "id"));
    revalidateSubject(slug, subject);
    return { ok: true, message: "Yorum silindi." };
  } catch (e) {
    return toActionState(e);
  }
}
