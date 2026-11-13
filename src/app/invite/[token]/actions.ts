"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireUser } from "@/lib/tenant";
import { acceptInvitation } from "@/server/workspaces";

export async function acceptInvitationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  let slug: string;
  try {
    const result = await acceptInvitation(
      { userId: user.id, email: user.email },
      formString(formData, "token"),
    );
    slug = result.workspace.slug;
  } catch (e) {
    return toActionState(e);
  }
  revalidatePath("/app");
  redirect(`/w/${slug}`);
}
