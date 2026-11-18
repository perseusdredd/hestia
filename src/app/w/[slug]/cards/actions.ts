"use server";

import { revalidatePath } from "next/cache";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import {
  createCard,
  createColumn,
  deleteCard,
  deleteColumn,
  moveCard,
  moveColumn,
  renameColumn,
  updateCard,
} from "@/server/cards";

function revalidate(slug: string) {
  revalidatePath(`/w/${slug}/cards`);
}

function cardInput(formData: FormData) {
  return {
    title: formString(formData, "title"),
    notes: formString(formData, "notes"),
    assigneeId: formString(formData, "assigneeId"),
    dueOn: formString(formData, "dueOn"),
  };
}

export async function createCardAction(
  slug: string,
  columnId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await createCard(ctx, columnId, cardInput(formData));
    revalidate(slug);
    return { ok: true, message: "Kart eklendi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function updateCardAction(
  slug: string,
  cardId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await updateCard(ctx, cardId, cardInput(formData));
    revalidate(slug);
    return { ok: true, message: "Kart güncellendi." };
  } catch (e) {
    return toActionState(e);
  }
}

/** Reorder inside the column: `direction` "up" | "down". */
export async function moveCardDirectionAction(
  slug: string,
  cardId: string,
  direction: "up" | "down",
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await moveCard(ctx, cardId, { direction });
    revalidate(slug);
    return { ok: true };
  } catch (e) {
    return toActionState(e);
  }
}

/** Move to the end of another column. */
export async function moveCardColumnAction(
  slug: string,
  cardId: string,
  columnId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await moveCard(ctx, cardId, { columnId });
    revalidate(slug);
    return { ok: true };
  } catch (e) {
    return toActionState(e);
  }
}

export async function deleteCardAction(
  slug: string,
  cardId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await deleteCard(ctx, cardId);
    revalidate(slug);
    return { ok: true, message: "Kart silindi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function createColumnAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await createColumn(ctx, { name: formString(formData, "name") });
    revalidate(slug);
    return { ok: true, message: "Sütun eklendi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function renameColumnAction(
  slug: string,
  columnId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await renameColumn(ctx, columnId, { name: formString(formData, "name") });
    revalidate(slug);
    return { ok: true, message: "Sütun yeniden adlandırıldı." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function moveColumnAction(
  slug: string,
  columnId: string,
  direction: "up" | "down",
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await moveColumn(ctx, columnId, direction);
    revalidate(slug);
    return { ok: true };
  } catch (e) {
    return toActionState(e);
  }
}

export async function deleteColumnAction(
  slug: string,
  columnId: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await deleteColumn(ctx, columnId);
    revalidate(slug);
    return { ok: true, message: "Sütun silindi." };
  } catch (e) {
    return toActionState(e);
  }
}
