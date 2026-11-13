"use server";

import { revalidatePath } from "next/cache";

import { unstable_update } from "@/auth";
import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { createSessionReissueProof } from "@/server/auth-tokens";
import { requireUser, requireWorkspace } from "@/lib/tenant";
import { changePassword, updateProfile } from "@/server/account";
import { AUTH_LIMITS, hitRateLimit } from "@/server/rate-limit";
import { leaveWorkspace } from "@/server/workspaces";

export async function updateProfileAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: formString(formData, "name") };
  try {
    const user = await requireUser();
    const result = await updateProfile(user.id, values);
    revalidatePath("/account");
    revalidatePath("/", "layout");
    return { ok: true, message: "Adınız güncellendi.", values: { name: result.name } };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function changePasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const user = await requireUser();
    // Same budget idea as login: the current-password check must not be brute-forceable.
    if (!hitRateLimit(`password-change:user:${user.id}`, AUTH_LIMITS.passwordChangePerUser)) {
      return { ok: false, error: "Çok fazla deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin." };
    }
    const result = await changePassword(user.id, {
      currentPassword: formString(formData, "currentPassword") || undefined,
      newPassword: formString(formData, "newPassword"),
    });
    // The bump revoked every JWT, this one included. Re-issue only this
    // browser's cookie with the new version (server-minted proof, see src/auth.ts).
    try {
      await unstable_update({
        sessionReissue: createSessionReissueProof(user.id, result.sessionVersion),
      });
    } catch (e) {
      console.error("[account] session re-issue failed:", e instanceof Error ? e.message : e);
      return {
        ok: true,
        message: "Şifreniz güncellendi. Güvenliğiniz için lütfen yeniden giriş yapın.",
      };
    }
    revalidatePath("/account");
    return {
      ok: true,
      message: "Şifreniz güncellendi. Diğer cihazlardaki oturumlarınız kapatıldı.",
    };
  } catch (e) {
    return toActionState(e);
  }
}

/** Leave a workspace from the account page (stays on /account instead of redirecting). */
export async function leaveWorkspaceFromAccountAction(
  slug: string,
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  void _formData;
  try {
    const { ctx } = await requireWorkspace(slug);
    await leaveWorkspace(ctx);
    revalidatePath("/account");
    revalidatePath("/app");
    return { ok: true, message: "Çalışma alanından ayrıldınız." };
  } catch (e) {
    return toActionState(e);
  }
}
