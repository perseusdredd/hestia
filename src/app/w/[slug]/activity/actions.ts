"use server";

import { formString, toActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import { ACTIVITY_GROUPS, isActivityGroup, listActivity } from "@/server/activity";
import { toActivityView, type ActivityView } from "@/components/activity/activity-view";

export type ActivityPageState = {
  ok?: boolean;
  error?: string;
  /** Only the batch just loaded; the client appends it. */
  items?: ActivityView[];
  nextCursor?: string | null;
};

/** "Daha fazla yükle": the next page after `cursor` with the same filters. Read-only. */
export async function loadMoreActivityAction(
  slug: string,
  _prev: ActivityPageState,
  formData: FormData,
): Promise<ActivityPageState> {
  void _prev;
  try {
    const { ctx } = await requireWorkspace(slug);
    const group = formString(formData, "group");
    const actorId = formString(formData, "actor").trim();
    const page = await listActivity(ctx, {
      cursor: formString(formData, "cursor") || null,
      types: isActivityGroup(group) ? [...ACTIVITY_GROUPS[group]] : null,
      actorId: actorId || null,
    });
    return { ok: true, items: page.items.map(toActivityView), nextCursor: page.nextCursor };
  } catch (e) {
    const state = toActionState(e);
    return { ok: false, error: state.error };
  }
}
