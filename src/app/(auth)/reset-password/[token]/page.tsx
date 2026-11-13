import type { Metadata } from "next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { ResetPasswordForm } from "../../auth-forms";

export const metadata: Metadata = { title: "Yeni şifre belirle", referrer: "no-referrer" };

// The token is only checked (and redeemed) on submit, so a mail scanner that
// opens the link cannot use it up.
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl font-semibold tracking-tight">Yeni şifre belirle</CardTitle>
        <CardDescription>
          Yeni şifrenizi kaydettiğinizde tüm cihazlardaki oturumlarınız kapanır.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ResetPasswordForm token={token.slice(0, 200)} />
      </CardContent>
    </Card>
  );
}
