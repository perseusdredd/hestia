"use server";

import { revalidatePath } from "next/cache";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import { subscribe, unsubscribe, type SubscriptionSubject } from "@/server/subscriptions";

/**
 * Subscribe / unsubscribe the caller to a post, to-do or event. The subject
 * sent by the client is only a hint: the service validates it inside the
 * caller's workspace.
 */

function revalidateSubject(slug: string, s: SubscriptionSubject) {
  const segment = s.type === "post" ? "messages" : s.type === "todo" ? "todos" : "calendar";
  revalidatePath(`/w/${slug}/${segment}`, "layout");
}

export async function toggleSubscriptionAction(
  slug: string,
  subjectType: string,
  subjectId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const wantSubscribed = formString(formData, "subscribed") === "true";
  try {
    const { ctx } = await requireWorkspace(slug);
    const subject = { type: subjectType, id: subjectId };
    const s = wantSubscribed ? await subscribe(ctx, subject) : await unsubscribe(ctx, subject);
    revalidateSubject(slug, s);
    return {
      ok: true,
      message: wantSubscribed ? "Abone oldunuz." : "Abonelikten çıktınız.",
    };
  } catch (e) {
    return toActionState(e);
  }
}
