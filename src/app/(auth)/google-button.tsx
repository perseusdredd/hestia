import { SubmitButton } from "@/components/submit-button";

import { googleSignInAction } from "./actions";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4">
      <path
        fill="currentColor"
        d="M21.35 11.1H12v2.98h5.35c-.23 1.5-1.68 4.4-5.35 4.4-3.22 0-5.85-2.67-5.85-5.96S8.78 6.56 12 6.56c1.83 0 3.06.78 3.76 1.45l2.57-2.47C16.68 4.01 14.55 3 12 3 6.98 3 2.92 7.03 2.92 12S6.98 21 12 21c5.2 0 8.65-3.66 8.65-8.8 0-.59-.06-1.04-.15-1.1z"
      />
    </svg>
  );
}

/** Rendered only when Google OAuth is configured. */
export function GoogleButton({ callbackUrl }: { callbackUrl: string }) {
  return (
    <form action={googleSignInAction}>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <SubmitButton variant="outline" size="lg" className="w-full">
        <GoogleMark />
        Google ile devam et
      </SubmitButton>
    </form>
  );
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      veya
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
