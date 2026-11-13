import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { AccountWorkspaceList } from "@/components/account/workspace-list";
import { PasswordForm, ProfileForm } from "@/components/account/account-forms";
import { PageHeader } from "@/components/page-header";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/tenant";
import { getAccount } from "@/server/account";
import { listUserWorkspaces } from "@/server/workspaces";

import {
  changePasswordAction,
  leaveWorkspaceFromAccountAction,
  updateProfileAction,
} from "./actions";

export const metadata: Metadata = { title: "Hesabım" };

export default async function AccountPage() {
  const user = await requireUser();
  const [account, workspaces] = await Promise.all([getAccount(user.id), listUserWorkspaces(user.id)]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Hesabım"
        description="Profil, şifre, görünüm ve çalışma alanlarınız."
        actions={
          <Link href="/app" className={buttonVariants({ variant: "outline" })}>
            <ArrowLeft aria-hidden />
            Çalışma alanlarım
          </Link>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Profil</CardTitle>
          <CardDescription>Adınız çalışma alanlarında diğer üyelere görünür.</CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm
            name={account.name ?? ""}
            email={account.email}
            action={updateProfileAction}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Şifre</CardTitle>
          <CardDescription>
            {account.hasPassword
              ? "Şifrenizi değiştirmek için mevcut şifrenizi girin."
              : "Henüz bir şifreniz yok."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordForm hasPassword={account.hasPassword} action={changePasswordAction} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Görünüm</CardTitle>
          <CardDescription>Açık, koyu veya cihazınızın temasını kullanın.</CardDescription>
        </CardHeader>
        <CardContent>
          <ThemeToggle />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Çalışma alanlarım</CardTitle>
          <CardDescription>Üyesi olduğunuz çalışma alanları ve rolünüz.</CardDescription>
        </CardHeader>
        <CardContent>
          <AccountWorkspaceList
            workspaces={workspaces}
            leaveAction={(slug) => leaveWorkspaceFromAccountAction.bind(null, slug)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
