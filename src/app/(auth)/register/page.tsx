import type { Metadata } from "next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isGoogleAuthEnabled, safeCallbackUrl } from "@/lib/safe-redirect";
import { getInvitationByToken } from "@/server/workspaces";

import { RegisterForm } from "../auth-forms";
import { GoogleButton, OrDivider } from "../google-button";

export const metadata: Metadata = { title: "Kayıt ol" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function RegisterPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const callbackUrl = safeCallbackUrl(first(sp.callbackUrl));
  const google = isGoogleAuthEnabled();
  // Coming from an invite link: say which workspace the new account is about to join.
  const inviteToken = /^\/invite\/([A-Za-z0-9_.-]+)/.exec(callbackUrl)?.[1];
  const invite = inviteToken ? await getInvitationByToken(inviteToken) : null;
  const joining = invite?.status === "valid" ? invite.workspace.name : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl font-semibold tracking-tight">Hesap oluştur</CardTitle>
        <CardDescription>
          {joining
            ? `${joining} çalışma alanına katılmak için hesap oluşturun.`
            : "Birkaç saniyede başlayın, ardından ekibinizi davet edin."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {google ? (
          <>
            <GoogleButton callbackUrl={callbackUrl} />
            <OrDivider />
          </>
        ) : null}
        <RegisterForm callbackUrl={callbackUrl} defaultEmail={first(sp.email)} />
      </CardContent>
    </Card>
  );
}
