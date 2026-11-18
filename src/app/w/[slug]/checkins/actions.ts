"use server";

import { revalidatePath } from "next/cache";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import { answerCheckin, createQuestion, setActive, updateQuestion } from "@/server/checkins";

function revalidate(slug: string) {
  revalidatePath(`/w/${slug}/checkins`);
}

function questionInput(formData: FormData) {
  return {
    text: formString(formData, "text"),
    weekdays: formData.getAll("weekdays").map((v) => Number(v)),
    hour: Number(formString(formData, "hour") || "NaN"),
  };
}

export async function answerCheckinAction(
  slug: string,
  roundId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    await answerCheckin(ctx, roundId, formString(formData, "body"));
    revalidate(slug);
    return { ok: true, message: "Cevabınız kaydedildi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function createQuestionAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await createQuestion(ctx, questionInput(formData));
    revalidate(slug);
    return { ok: true, message: "Soru eklendi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function updateQuestionAction(
  slug: string,
  questionId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await updateQuestion(ctx, questionId, questionInput(formData));
    revalidate(slug);
    return { ok: true, message: "Soru güncellendi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function setQuestionActiveAction(
  slug: string,
  questionId: string,
  active: boolean,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await setActive(ctx, questionId, active);
    revalidate(slug);
    return { ok: true, message: active ? "Soru etkinleştirildi." : "Soru durduruldu." };
  } catch (e) {
    return toActionState(e);
  }
}
