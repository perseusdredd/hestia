"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { getRequestOrigin } from "@/lib/request-origin";
import { requireWorkspace } from "@/lib/tenant";
import {
  createCategory,
  deleteCategory,
  moveCategory,
  updateCategory,
} from "@/server/message-categories";
import { NOTIFICATION_TYPES } from "@/server/notifications";
import { setMutedTypes } from "@/server/notification-preferences";
import { hitInviteRateLimit } from "@/server/rate-limit";
import {
  changeMemberRole,
  createInvitation,
  createInviteLink,
  deleteWorkspace,
  leaveWorkspace,
  removeMember,
  renameWorkspace,
  revokeInvitation,
} from "@/server/workspaces";

export type InviteResult = {
  inviteUrl: string;
  email: string;
  /** "queued" (outbox driver), "sent" or "failed" (SMTP error / no trusted origin). */
  emailStatus: "queued" | "sent" | "failed";
};

const TOO_MANY_INVITES = "Çok fazla davet gönderildi. Lütfen bir süre sonra tekrar deneyin.";

function revalidate(slug: string) {
  revalidatePath(`/w/${slug}`, "layout");
}

export async function inviteMemberAction(
  slug: string,
  _prev: ActionState<InviteResult>,
  formData: FormData,
): Promise<ActionState<InviteResult>> {
  const values = { email: formString(formData, "email"), role: formString(formData, "role") };
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    // Every invite mails inviter-chosen text: throttle before anything is written.
    if (!hitInviteRateLimit(ctx, values.email)) {
      return { ok: false, error: TOO_MANY_INVITES, values };
    }
    const { invitation, token, deliverEmail } = await createInvitation(ctx, values);
    // Shown only to this admin, so the request origin is fine here; the
    // emailed link is built from the trusted AUTH_URL origin in the service.
    const inviteUrl = `${await getRequestOrigin()}/invite/${token}`;
    const emailStatus = await deliverEmail(); // never throws
    revalidate(slug);
    return { ok: true, data: { inviteUrl, email: invitation.email ?? values.email, emailStatus } };
  } catch (e) {
    return { ...toActionState<InviteResult>(e), values };
  }
}

/** Creates a reusable invite link (no e-mail needed). The link shows up in "Bekleyen davetler". */
export async function createInviteLinkAction(
  slug: string,
  _prev: ActionState<{ id: string }>,
  formData: FormData,
): Promise<ActionState<{ id: string }>> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    if (!hitInviteRateLimit(ctx, "invite-link")) return { ok: false, error: TOO_MANY_INVITES };
    const { invitation } = await createInviteLink(ctx, { role: formString(formData, "role") });
    revalidate(slug);
    return { ok: true, message: "Davet bağlantısı oluşturuldu.", data: { id: invitation.id } };
  } catch (e) {
    return toActionState<{ id: string }>(e);
  }
}

export async function revokeInvitationAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await revokeInvitation(ctx, formString(formData, "id"));
    revalidate(slug);
    return { ok: true, message: "Davet iptal edildi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function changeRoleAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await changeMemberRole(ctx, formString(formData, "id"), formString(formData, "role"));
    revalidate(slug);
    return { ok: true, message: "Rol güncellendi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function removeMemberAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await removeMember(ctx, formString(formData, "id"));
    revalidate(slug);
    return { ok: true, message: "Üye çıkarıldı." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function leaveWorkspaceAction(
  slug: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  void _formData;
  try {
    const { ctx } = await requireWorkspace(slug);
    await leaveWorkspace(ctx);
  } catch (e) {
    return toActionState(e);
  }
  revalidatePath("/app");
  redirect("/app");
}

export async function renameWorkspaceAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: formString(formData, "name") };
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await renameWorkspace(ctx, values);
    revalidate(slug);
    return { ok: true, message: "Çalışma alanı adı güncellendi.", values };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function deleteWorkspaceAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "OWNER");
    await deleteWorkspace(ctx, { confirmSlug: formString(formData, "confirmSlug") });
  } catch (e) {
    return toActionState(e);
  }
  revalidatePath("/app");
  redirect("/app");
}

/** Saves the caller's muted notification types (form: checked "enabled" types stay on, the rest are muted). */
export async function saveNotificationPreferencesAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const enabled = new Set(formData.getAll("enabled").map(String));
    await setMutedTypes(
      ctx,
      NOTIFICATION_TYPES.filter((t) => !enabled.has(t)),
    );
    revalidate(slug);
    return { ok: true, message: "Bildirim tercihleri kaydedildi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function createCategoryAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await createCategory(ctx, { name: formString(formData, "name"), emoji: formString(formData, "emoji") });
    revalidate(slug);
    return { ok: true, message: "Kategori eklendi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function updateCategoryAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await updateCategory(ctx, formString(formData, "id"), {
      name: formString(formData, "name"),
      emoji: formString(formData, "emoji"),
    });
    revalidate(slug);
    return { ok: true, message: "Kategori güncellendi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function deleteCategoryAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await deleteCategory(ctx, formString(formData, "id"));
    revalidate(slug);
    return { ok: true, message: "Kategori silindi." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function moveCategoryAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug, "ADMIN");
    await moveCategory(ctx, formString(formData, "id"), formString(formData, "direction"));
    revalidate(slug);
    return { ok: true };
  } catch (e) {
    return toActionState(e);
  }
}
