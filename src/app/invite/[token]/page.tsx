import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MailX } from "lucide-react";

import { Logo } from "@/components/logo";
import { MAIN_ID } from "@/components/skip-link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { displayName } from "@/components/user-avatar";
import { formatDate } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/roles";
import { checkSession, sessionExpiredUrl } from "@/lib/tenant";
import { acceptInvitation, getInvitationByToken } from "@/server/workspaces";

import { AcceptInviteForm } from "./accept-form";

export const metadata: Metadata = { title: "Davet", robots: { index: false } };

const STATUS_TEXT = {
  expired: "Bu davetin süresi dolmuş. Yeni bir davet isteyin.",
  revoked: "Bu davet iptal edilmiş.",
  accepted: "Bu davet daha önce kullanılmış.",
} as const;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <Link href="/" className="mb-6" aria-label="Hestia ana sayfa">
        <Logo />
      </Link>
      <main id={MAIN_ID} tabIndex={-1} className="w-full max-w-sm outline-none">
        {children}
      </main>
    </div>
  );
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // A revoked JWT must be cleared here: the middleware still sees it as signed
  // in and would bounce /login straight back to this page (login loop).
  const check = await checkSession();
  if (check.status === "revoked") redirect(sessionExpiredUrl(`/invite/${token}`));
  const user = check.status === "ok" ? check.user : null;
  const invite = await getInvitationByToken(token, user?.id);

  if (!invite) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <MailX className="mb-2 size-6 text-muted-foreground" aria-hidden />
            <CardTitle className="text-xl font-semibold tracking-tight">Davet bulunamadı</CardTitle>
            <CardDescription>
              Bağlantı hatalı ya da artık geçerli değil. Sizi davet eden kişiden yeni bir bağlantı
              isteyin.
            </CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  const returnPath = `/invite/${token}`;
  const isMember = invite.viewerIsMember;
  const emailMatches = user
    ? invite.reusable || user.email.toLowerCase() === invite.email?.toLowerCase()
    : false;
  const emailQuery = invite.email ? `&email=${encodeURIComponent(invite.email)}` : "";
  const inviter = displayName(invite.invitedBy);

  if (!isMember && invite.status === "valid") {
    // Signed out: straight to the sign-up form (it has a "Giriş yap" link for existing accounts).
    // After signing up or in, the browser returns here.
    if (!user) redirect(`/register?callbackUrl=${encodeURIComponent(returnPath)}${emailQuery}`);
    // Link invites need no extra click: a signed-in visitor joins right away.
    if (invite.reusable) {
      let slug: string | null = null;
      try {
        slug = (await acceptInvitation({ userId: user.id, email: user.email }, token)).workspace.slug;
      } catch {
        // Revoked/expired in the meantime or the inviter lost the right: show the page below.
      }
      if (slug) redirect(`/w/${slug}`);
    }
  }

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardDescription>{inviter} sizi davet etti</CardDescription>
          <CardTitle className="text-xl">{invite.workspace.name}</CardTitle>
          <CardDescription>
            Rol: {ROLE_LABELS[invite.role]}
            {invite.status === "valid" && invite.expiresAt
              ? ` · ${formatDate(invite.expiresAt)} tarihine kadar geçerli`
              : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {isMember ? (
            <>
              <p className="text-sm text-muted-foreground">Bu çalışma alanının zaten üyesisiniz.</p>
              <Link href={`/w/${invite.workspace.slug}`} className={buttonVariants({ size: "lg" })}>
                Çalışma alanına git
              </Link>
            </>
          ) : invite.status !== "valid" ? (
            <p className="text-sm text-muted-foreground">{STATUS_TEXT[invite.status]}</p>
          ) : !user ? null : !emailMatches ? (
            <p className="text-sm text-muted-foreground">
              Bu davet <span className="font-medium text-foreground">{invite.email}</span> adresine
              gönderilmiş, ancak siz <span className="font-medium text-foreground">{user.email}</span>{" "}
              olarak giriş yaptınız. Davet edilen adresle giriş yapın.
            </p>
          ) : (
            <AcceptInviteForm token={token} />
          )}
        </CardContent>
      </Card>
    </Shell>
  );
}
