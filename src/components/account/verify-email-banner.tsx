"use client";

import { useActionState, useState } from "react";
import { usePathname } from "next/navigation";
import { MailWarning, X } from "lucide-react";

import { resendVerificationAction } from "@/app/(auth)/actions";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/action-state";
import { hidesVerifyBanner, VERIFY_BANNER_COOKIE } from "@/lib/verify-banner";

/**
 * Reminder for signed-in users whose email is not verified yet. The layouts
 * render it only when `user.emailVerified` is null and the dismissal cookie
 * (a session cookie read on the server, so a dismissed banner is never
 * painted and then removed) does not match. It carries its own bottom margin.
 */
export function VerifyEmailBanner({ email }: { email: string }) {
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(false);
  const [state, action, pending] = useActionState<ActionState, FormData>(
    resendVerificationAction,
    {},
  );

  if (dismissed || hidesVerifyBanner(pathname)) return null;

  function dismiss() {
    setDismissed(true);
    // Session cookie (no max-age): hidden until the browser session ends.
    document.cookie = `${VERIFY_BANNER_COOKIE}=${encodeURIComponent(email)}; path=/; SameSite=Lax`;
  }

  return (
    <div
      role="region"
      aria-label="Hesap doğrulama uyarısı"
      className="mb-6 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2.5 text-sm"
    >
      <MailWarning className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p>
          E-posta adresinizi henüz doğrulamadınız. <span className="font-medium [overflow-wrap:anywhere]">{email}</span>{" "}
          adresine gönderdiğimiz bağlantıyı açın.
        </p>
        {state.error ? (
          <p role="alert" className="text-destructive">
            {state.error}
          </p>
        ) : state.ok && state.message ? (
          <p role="status" className="text-muted-foreground">
            {state.message}
          </p>
        ) : null}
        <form action={action}>
          <SubmitButton
            pending={pending}
            pendingText="Gönderiliyor"
            variant="link"
            size="sm"
            className="px-0"
          >
            Tekrar gönder
          </SubmitButton>
        </form>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={dismiss}
        aria-label="Uyarıyı kapat"
        className="-mr-1 shrink-0"
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}
