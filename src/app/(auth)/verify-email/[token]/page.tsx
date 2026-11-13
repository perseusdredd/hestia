import type { Metadata } from "next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { VerifyEmailForm } from "../../auth-forms";

export const metadata: Metadata = { title: "E-posta doğrulama", referrer: "no-referrer" };

// Verification happens on the button press (POST), not on page load, so link
// pre-fetchers in mail clients cannot redeem the token.
export default async function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl font-semibold tracking-tight">E-posta adresinizi doğrulayın</CardTitle>
        <CardDescription>Doğrulamayı tamamlamak için aşağıdaki düğmeye basın.</CardDescription>
      </CardHeader>
      <CardContent>
        <VerifyEmailForm token={token.slice(0, 200)} />
      </CardContent>
    </Card>
  );
}
