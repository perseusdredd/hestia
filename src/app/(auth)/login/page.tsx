import type { Metadata } from "next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isGoogleAuthEnabled, safeCallbackUrl } from "@/lib/safe-redirect";

import { FormNotice, LoginForm } from "../auth-forms";
import { GoogleButton, OrDivider } from "../google-button";

export const metadata: Metadata = { title: "Giriş yap" };

const ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    "Bu e-posta adresi başka bir giriş yöntemiyle kayıtlı. Lütfen e-posta ve şifrenizle giriş yapın.",
  AccessDenied: "Giriş izni verilmedi.",
  Configuration: "Giriş şu anda kullanılamıyor. Lütfen daha sonra tekrar deneyin.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const callbackUrl = safeCallbackUrl(first(sp.callbackUrl));
  const errorCode = first(sp.error);
  const initialError = errorCode
    ? (ERROR_MESSAGES[errorCode] ?? "Giriş yapılamadı. Lütfen tekrar deneyin.")
    : undefined;
  const google = isGoogleAuthEnabled();
  const notice =
    first(sp.reset) === "1"
      ? "Şifreniz güncellendi. Yeni şifrenizle giriş yapın."
      : first(sp.expired) === "1"
        ? "Oturumunuz sonlandırıldı. Lütfen tekrar giriş yapın."
        : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl font-semibold tracking-tight">Giriş yap</CardTitle>
        <CardDescription>Çalışma alanlarınıza devam edin.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <FormNotice message={initialError ? undefined : notice} />
        {google ? (
          <>
            <GoogleButton callbackUrl={callbackUrl} />
            <OrDivider />
          </>
        ) : null}
        <LoginForm
          callbackUrl={callbackUrl}
          initialError={initialError}
          defaultEmail={first(sp.email)}
        />
      </CardContent>
    </Card>
  );
}
