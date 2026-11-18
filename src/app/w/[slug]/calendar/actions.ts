"use server";

import { revalidatePath } from "next/cache";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import { createEvent, deleteEvent, updateEvent } from "@/server/calendar";

function readEvent(formData: FormData) {
  return {
    title: formString(formData, "title"),
    description: formString(formData, "description"),
    location: formString(formData, "location"),
    allDay: formString(formData, "allDay") === "on",
    startsAt: formString(formData, "startsAt"),
    endsAt: formString(formData, "endsAt"),
    recurrence: formString(formData, "recurrence") || undefined,
    recurrenceUntil: formString(formData, "recurrenceUntil"),
    inviteeIds: formData.getAll("inviteeIds").map(String),
  };
}

function toValues(v: ReturnType<typeof readEvent>): Record<string, string> {
  const { inviteeIds: _inviteeIds, recurrence, ...rest } = v;
  void _inviteeIds;
  return { ...rest, recurrence: recurrence ?? "NONE", allDay: v.allDay ? "on" : "" };
}

export async function createEventAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const input = readEvent(formData);
  try {
    const { ctx } = await requireWorkspace(slug);
    await createEvent(ctx, input);
    revalidatePath(`/w/${slug}/calendar`);
    return { ok: true, message: "Etkinlik eklendi." };
  } catch (e) {
    return { ...toActionState(e), values: toValues(input) };
  }
}

export async function updateEventAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const input = readEvent(formData);
  try {
    const { ctx } = await requireWorkspace(slug);
    await updateEvent(ctx, formString(formData, "id"), input);
    revalidatePath(`/w/${slug}/calendar`);
    return { ok: true, message: "Etkinlik güncellendi." };
  } catch (e) {
    return { ...toActionState(e), values: toValues(input) };
  }
}

export async function deleteEventAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await deleteEvent(ctx, formString(formData, "id"));
    revalidatePath(`/w/${slug}/calendar`);
    return { ok: true, message: "Etkinlik silindi." };
  } catch (e) {
    return toActionState(e);
  }
}
