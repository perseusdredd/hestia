"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import { markAllRead, markRead } from "@/server/notifications";

/** Mark one notification read, then open its target page. */
export async function openNotificationAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let target: string;
  try {
    const { ctx, workspace } = await requireWorkspace(slug);
    const { path } = await markRead(ctx, formString(formData, "id"));
    revalidatePath(`/w/${workspace.slug}`, "layout");
    // `path` is validated as workspace-relative (no scheme, no leading slash, no "..").
    target = `/w/${workspace.slug}/${path}`;
  } catch (e) {
    return toActionState(e);
  }
  redirect(target);
}

export async function markAllReadAction(
  slug: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  void _formData;
  try {
    const { ctx } = await requireWorkspace(slug);
    const count = await markAllRead(ctx);
    revalidatePath(`/w/${slug}`, "layout");
    return {
      ok: true,
      message: count ? "Tüm bildirimler okundu olarak işaretlendi." : "Okunmamış bildirim yok.",
    };
  } catch (e) {
    return toActionState(e);
  }
}
