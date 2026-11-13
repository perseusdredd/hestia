import { cookies } from "next/headers";
import Link from "next/link";

import { VerifyEmailBanner } from "@/components/account/verify-email-banner";
import { Logo } from "@/components/logo";
import { UserMenu } from "@/components/shell/user-menu";
import { requireUser } from "@/lib/tenant";
import { isVerifyBannerDismissed, VERIFY_BANNER_COOKIE } from "@/lib/verify-banner";
import { MAIN_ID } from "@/components/skip-link";

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const showVerifyBanner =
    !user.emailVerified &&
    !isVerifyBannerDismissed((await cookies()).get(VERIFY_BANNER_COOKIE)?.value, user.email);
  return (
    <div className="flex min-h-dvh flex-col bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center justify-between px-4 sm:px-6">
          <Link href="/app" aria-label="Hestia, çalışma alanlarım">
            <Logo />
          </Link>
          <UserMenu user={user} />
        </div>
      </header>
      <main id={MAIN_ID} tabIndex={-1} className="outline-none mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        {showVerifyBanner ? <VerifyEmailBanner email={user.email} /> : null}
        {children}
      </main>
    </div>
  );
}
