import type { Metadata } from "next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isGoogleAuthEnabled, safeCallbackUrl } from "@/lib/safe-redirect";

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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl font-semibold tracking-tight">Hesap oluştur</CardTitle>
        <CardDescription>Birkaç saniyede başlayın, ardından ekibinizi davet edin.</CardDescription>
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
