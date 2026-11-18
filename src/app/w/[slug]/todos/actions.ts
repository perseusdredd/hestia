"use server";

import { revalidatePath } from "next/cache";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import { getHillHistory, setHillPosition, type HillSnapshotDTO } from "@/server/hill";
import {
  createTodoItem,
  createTodoList,
  createTodoSection,
  deleteTodoSection,
  moveTodoSection,
  renameTodoSection,
  deleteTodoItem,
  deleteTodoList,
  moveTodoItem,
  moveTodoList,
  setTodoItemDone,
  updateTodoItem,
  updateTodoList,
} from "@/server/todos";

function revalidate(slug: string) {
  revalidatePath(`/w/${slug}/todos`);
  revalidatePath(`/w/${slug}`);
}

export async function createListAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = {
    name: formString(formData, "name"),
    description: formString(formData, "description"),
  };
  try {
    const { ctx } = await requireWorkspace(slug);
    await createTodoList(ctx, values);
    revalidate(slug);
    return { ok: true, message: "Liste oluşturuldu." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function updateListAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = {
    name: formString(formData, "name"),
    description: formString(formData, "description"),
  };
  try {
    const { ctx } = await requireWorkspace(slug);
    await updateTodoList(ctx, formString(formData, "id"), values);
    revalidate(slug);
    return { ok: true, message: "Liste güncellendi." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function deleteListAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await deleteTodoList(ctx, formString(formData, "id"));
    revalidate(slug);
    return { ok: true, message: "Liste silindi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function createItemAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { title: formString(formData, "title") };
  try {
    const { ctx } = await requireWorkspace(slug);
    await createTodoItem(ctx, formString(formData, "listId"), {
      ...values,
      sectionId: formString(formData, "sectionId"),
    });
    revalidate(slug);
    return { ok: true };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function updateItemAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = {
    title: formString(formData, "title"),
    notes: formString(formData, "notes"),
    assigneeId: formString(formData, "assigneeId"),
    dueDate: formString(formData, "dueDate"),
    startOn: formString(formData, "startOn"),
  };
  try {
    const { ctx } = await requireWorkspace(slug);
    const id = formString(formData, "id");
    const sectionId = formData.has("sectionId") ? formString(formData, "sectionId") : undefined;
    await updateTodoItem(ctx, id, {
      ...values,
      ...(sectionId !== undefined ? { sectionId } : {}),
      // Only replace extra assignees when the form actually rendered the picker
      // (marker present); otherwise leave the existing extras untouched.
      ...(formData.has("extraAssigneesPresent")
        ? { extraAssigneeIds: formData.getAll("extraAssigneeIds").map(String).filter(Boolean) }
        : {}),
    });
    const listId = formString(formData, "listId");
    if (listId) await moveTodoItem(ctx, id, { listId }); // no-op when unchanged
    revalidate(slug);
    return { ok: true, message: "Görev güncellendi." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function toggleItemAction(
  slug: string,
  id: string,
  done: boolean,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await setTodoItemDone(ctx, id, Boolean(done));
    revalidate(slug);
    return { ok: true };
  } catch (e) {
    return toActionState(e);
  }
}

export async function deleteItemAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await deleteTodoItem(ctx, formString(formData, "id"));
    revalidate(slug);
    return { ok: true, message: "Görev silindi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function moveItemAction(
  slug: string,
  id: string,
  direction: "up" | "down",
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await moveTodoItem(ctx, id, { direction });
    revalidate(slug);
    return { ok: true };
  } catch (e) {
    return toActionState(e);
  }
}

export async function moveListAction(
  slug: string,
  id: string,
  direction: "up" | "down",
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await moveTodoList(ctx, id, direction);
    revalidate(slug);
    return { ok: true };
  } catch (e) {
    return toActionState(e);
  }
}

export async function setHillAction(
  slug: string,
  listId: string,
  position: number,
  note: string,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await setHillPosition(ctx, listId, position, note);
    revalidate(slug);
    return { ok: true, message: "Tepe konumu güncellendi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function hillHistoryAction(
  slug: string,
  listId: string,
): Promise<{ ok: true; history: HillSnapshotDTO[] } | { ok: false; error: string }> {
  try {
    const { ctx } = await requireWorkspace(slug);
    return { ok: true, history: await getHillHistory(ctx, listId) };
  } catch (e) {
    return { ok: false, error: toActionState(e).error ?? "Geçmiş yüklenemedi." };
  }
}

export async function createSectionAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: formString(formData, "name") };
  try {
    const { ctx } = await requireWorkspace(slug);
    await createTodoSection(ctx, formString(formData, "listId"), values);
    revalidate(slug);
    return { ok: true, message: "Bölüm eklendi." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function renameSectionAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: formString(formData, "name") };
  try {
    const { ctx } = await requireWorkspace(slug);
    await renameTodoSection(ctx, formString(formData, "id"), values);
    revalidate(slug);
    return { ok: true, message: "Bölüm güncellendi." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function deleteSectionAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await deleteTodoSection(ctx, formString(formData, "id"));
    revalidate(slug);
    return { ok: true, message: "Bölüm silindi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function moveSectionAction(
  slug: string,
  id: string,
  direction: "up" | "down",
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await moveTodoSection(ctx, id, direction);
    revalidate(slug);
    return { ok: true };
  } catch (e) {
    return toActionState(e);
  }
}
