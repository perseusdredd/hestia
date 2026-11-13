"use server";

import { redirect } from "next/navigation";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireUser } from "@/lib/tenant";
import { createWorkspace } from "@/server/workspaces";

export async function createWorkspaceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const values = { name: formString(formData, "name"), slug: formString(formData, "slug") };
  let slug: string;
  try {
    const workspace = await createWorkspace({ userId: user.id }, values);
    slug = workspace.slug;
  } catch (e) {
    return { ...toActionState(e), values };
  }
  redirect(`/w/${slug}`);
}
