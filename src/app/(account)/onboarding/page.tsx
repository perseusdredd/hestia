import type { Metadata } from "next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { CreateWorkspaceForm } from "./create-workspace-form";

export const metadata: Metadata = { title: "Yeni çalışma alanı" };

export default function OnboardingPage() {
  return (
    <div className="mx-auto max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl font-semibold tracking-tight">Yeni çalışma alanı</CardTitle>
          <CardDescription>
            Her müşteri ya da ekip için ayrı bir alan açın. Üyeler yalnızca davet edildikleri
            alanları görür.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateWorkspaceForm />
        </CardContent>
      </Card>
    </div>
  );
}
