"use server";

import { revalidatePath } from "next/cache";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import {
  createProjectFromTemplate,
  createTemplate,
  deleteTemplate,
  renameTemplate,
  saveProjectAsTemplate,
} from "@/server/project-templates";
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

// ---- templates (Şablonlar) ----

export async function createTemplateAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: formString(formData, "name"), description: formString(formData, "description") };
  try {
    const { ctx } = await requireWorkspace(slug);
    await createTemplate(ctx, values);
    revalidate(slug);
    return { ok: true, message: "Şablon oluşturuldu." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function saveProjectAsTemplateAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await saveProjectAsTemplate(ctx, formString(formData, "id"));
    revalidate(slug);
    return { ok: true, message: "Şablon olarak kaydedildi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function renameTemplateAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: formString(formData, "name"), description: formString(formData, "description") };
  try {
    const { ctx } = await requireWorkspace(slug);
    await renameTemplate(ctx, formString(formData, "id"), values);
    revalidate(slug);
    return { ok: true, message: "Şablon güncellendi." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function deleteTemplateAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await deleteTemplate(ctx, formString(formData, "id"));
    revalidate(slug);
    return { ok: true, message: "Şablon silindi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function createProjectFromTemplateAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: formString(formData, "name") };
  try {
    const { ctx } = await requireWorkspace(slug);
    await createProjectFromTemplate(ctx, formString(formData, "id"), values);
    revalidate(slug);
    return { ok: true, message: "Proje şablondan oluşturuldu." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}
