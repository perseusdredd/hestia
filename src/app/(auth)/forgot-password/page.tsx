import type { Metadata } from "next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { ForgotPasswordForm } from "../auth-forms";

export const metadata: Metadata = { title: "Şifremi unuttum" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ForgotPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const email = Array.isArray(sp.email) ? sp.email[0] : sp.email;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl font-semibold tracking-tight">Şifremi unuttum</CardTitle>
        <CardDescription>
          E-posta adresinizi girin, yeni şifre belirlemeniz için bir bağlantı gönderelim. Google ile
          kayıt olduysanız bu yolla bir şifre de belirleyebilirsiniz.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ForgotPasswordForm defaultEmail={email?.slice(0, 254)} />
      </CardContent>
    </Card>
  );
}
