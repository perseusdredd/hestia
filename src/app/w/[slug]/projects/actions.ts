"use server";

import { revalidatePath } from "next/cache";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import { archiveProject, createProject, renameProject } from "@/server/projects";

function revalidate(slug: string) {
  revalidatePath(`/w/${slug}/projects`, "layout");
}

export async function createProjectAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: formString(formData, "name"), description: formString(formData, "description") };
  try {
    const { ctx } = await requireWorkspace(slug);
    await createProject(ctx, values);
    revalidate(slug);
    return { ok: true, message: "Proje oluşturuldu." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function renameProjectAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: formString(formData, "name"), description: formString(formData, "description") };
  try {
    const { ctx } = await requireWorkspace(slug);
    await renameProject(ctx, formString(formData, "id"), values);
    revalidate(slug);
    return { ok: true, message: "Proje güncellendi." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function archiveProjectAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await archiveProject(ctx, formString(formData, "id"), formString(formData, "archived") !== "false");
    revalidate(slug);
    return { ok: true, message: "Proje güncellendi." };
  } catch (e) {
    return toActionState(e);
  }
}
