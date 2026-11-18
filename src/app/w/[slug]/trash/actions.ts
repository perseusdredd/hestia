"use server";

import { revalidatePath } from "next/cache";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import { purgeTrashItem, restoreTrashItem } from "@/server/trash";

/** A restored item shows up in every module again: refresh the whole workspace. */
function revalidate(slug: string) {
  revalidatePath(`/w/${slug}`, "layout");
}

export async function restoreTrashAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const { title } = await restoreTrashItem(ctx, { kind: formString(formData, "kind"), id: formString(formData, "id") });
    revalidate(slug);
    return { ok: true, message: `“${title}” geri yüklendi.` };
  } catch (e) {
    return toActionState(e);
  }
}

export async function purgeTrashAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await purgeTrashItem(ctx, { kind: formString(formData, "kind"), id: formString(formData, "id") });
    revalidate(slug);
    return { ok: true, message: "Öğe kalıcı olarak silindi." };
  } catch (e) {
    return toActionState(e);
  }
}
