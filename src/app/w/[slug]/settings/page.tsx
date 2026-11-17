import type { Metadata } from "next";
import { LogOut, MailPlus, UserMinus, X } from "lucide-react";

import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDate } from "@/lib/format";
import { hasRole, ROLE_LABELS, type Role } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { listMembers, listPendingInvitations } from "@/server/workspaces";

import {
  leaveWorkspaceAction,
  removeMemberAction,
  revokeInvitationAction,
} from "./actions";
import { getRequestOrigin } from "@/lib/request-origin";
import {
  DeleteWorkspaceForm,
  InviteForm,
  InviteLinkField,
  InviteLinkForm,
  RenameWorkspaceForm,
  RoleSelect,
} from "./settings-forms";

export const metadata: Metadata = { title: "Ayarlar" };

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx, workspace } = await requireWorkspace(slug);
  const isAdmin = hasRole(ctx.role, "ADMIN");
  const isOwner = ctx.role === "OWNER";

  const [members, invitations] = await Promise.all([
    listMembers(ctx),
    isAdmin ? listPendingInvitations(ctx) : Promise.resolve([]),
  ]);

  const origin = isAdmin ? await getRequestOrigin() : "";
  const assignableRoles: Role[] = isOwner ? ["MEMBER", "ADMIN", "OWNER"] : ["MEMBER", "ADMIN"];
  const ownerCount = members.filter((m) => m.role === "OWNER").length;

  return (
    <div className="space-y-6">
      <PageHeader title="Ayarlar" description="Üyeler, davetler ve çalışma alanı bilgileri." />

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>Çalışma alanı adı</CardTitle>
            <CardDescription>Adres (/w/{workspace.slug}) değişmez.</CardDescription>
          </CardHeader>
          <CardContent>
            <RenameWorkspaceForm slug={slug} name={workspace.name} />
          </CardContent>
        </Card>
      ) : null}

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>Üye davet et</CardTitle>
            <CardDescription>
              Davet bağlantısı oluşturun ve kişiye iletin. Kişi aynı e-posta adresiyle giriş
              yaparak daveti kabul eder.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <InviteForm slug={slug} assignableRoles={assignableRoles} />
            <div className="mt-6 grid gap-2 border-t pt-5">
              <p className="text-sm font-medium">E-posta yazmadan davet bağlantısı</p>
              <p className="text-sm text-muted-foreground">
                Bağlantıya sahip olan herkes, giriş yapıp katılabilir. Kullanım sınırı ve süre yoktur;
                durdurmak için aşağıdaki &quot;Bekleyen davetler&quot; bölümünden iptal edin. Bağlantıyı
                yalnızca güvendiğiniz kişilerle paylaşın.
              </p>
              <InviteLinkForm slug={slug} assignableRoles={assignableRoles} />
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Üyeler</CardTitle>
          <CardDescription>{members.length} kişi bu çalışma alanına erişebilir.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {members.map((m) => {
              const isSelf = m.user.id === ctx.userId;
              const name = displayName(m.user);
              // Mirrors the service rules; the server re-checks everything.
              const canEditRole = isAdmin && (m.role !== "OWNER" || isOwner);
              const canRemove =
                !isSelf && isAdmin && (m.role !== "OWNER" || isOwner);
              const roleOptions: Role[] =
                m.role === "OWNER" || isOwner ? ["MEMBER", "ADMIN", "OWNER"] : ["MEMBER", "ADMIN"];
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <UserAvatar user={m.user} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {name}
                      {isSelf ? <span className="font-normal text-muted-foreground"> (siz)</span> : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{m.user.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {canEditRole ? (
                      <RoleSelect
                        slug={slug}
                        membershipId={m.id}
                        role={m.role}
                        options={roleOptions}
                        memberLabel={name}
                      />
                    ) : (
                      <Badge variant={m.role === "OWNER" ? "default" : "secondary"}>
                        {ROLE_LABELS[m.role]}
                      </Badge>
                    )}
                    {canRemove ? (
                      <ConfirmAction
                        action={removeMemberAction.bind(null, slug)}
                        fields={{ id: m.id }}
                        title={`${name} çıkarılsın mı?`}
                        description="Bu kişi çalışma alanına erişimini kaybeder. Oluşturduğu içerikler silinmez."
                        confirmLabel="Üyeyi çıkar"
                        successMessage="Üye çıkarıldı."
                        trigger={<UserMinus aria-hidden />}
                        triggerSize="icon-sm"
                        triggerLabel={`${name} kişisini çıkar`}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      {isAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>Bekleyen davetler</CardTitle>
            <CardDescription>Kabul edilmemiş davetler ve herkese açık davet bağlantıları.</CardDescription>
          </CardHeader>
          <CardContent>
            {invitations.length === 0 ? (
              <EmptyState
                icon={MailPlus}
                title="Bekleyen davet yok"
                description="Yeni bir davet oluşturduğunuzda burada görünür."
                className="py-8"
              />
            ) : (
              <ul className="divide-y">
                {invitations.map((inv) => {
                  const canRevoke = inv.role !== "OWNER" || isOwner;
                  return (
                    <li key={inv.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{inv.email ?? "Davet bağlantısı (herkes katılabilir)"}</p>
                        <p className="text-xs text-muted-foreground">
                          {inv.reusable
                            ? `${inv.useCount} kişi katıldı · süresiz`
                            : `${inv.expiresAt ? formatDate(inv.expiresAt) : ""} tarihine kadar geçerli`}{" "}
                          · {displayName(inv.invitedBy)} oluşturdu
                        </p>
                        {inv.linkToken ? (
                          <div className="mt-2">
                            <InviteLinkField url={`${origin}/invite/${inv.linkToken}`} />
                          </div>
                        ) : null}
                      </div>
                      <Badge variant="outline">{ROLE_LABELS[inv.role]}</Badge>
                      {canRevoke ? (
                        <ConfirmAction
                          action={revokeInvitationAction.bind(null, slug)}
                          fields={{ id: inv.id }}
                          title="Davet iptal edilsin mi?"
                          description={
                            inv.email
                              ? `${inv.email} adresine gönderilen bağlantı artık çalışmayacak.`
                              : "Bu bağlantıyla artık kimse katılamaz. Daha önce katılanlar üye kalır."
                          }
                          confirmLabel="Daveti iptal et"
                          successMessage="Davet iptal edildi."
                          trigger={<X aria-hidden />}
                          triggerSize="icon-sm"
                          triggerLabel={`${inv.email ?? "Davet bağlantısını"} iptal et`}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Çalışma alanından ayrıl</CardTitle>
          <CardDescription>
            {ctx.role === "OWNER" && ownerCount <= 1
              ? "Son sahip olduğunuz için ayrılmadan önce başka bir üyeyi sahip yapmalısınız."
              : "Ayrıldıktan sonra yeniden erişmek için yeni bir davet gerekir."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ConfirmAction
            action={leaveWorkspaceAction.bind(null, slug)}
            title={`${workspace.name} alanından ayrılmak istiyor musunuz?`}
            description="Bu çalışma alanının içeriklerine erişiminiz sona erer."
            confirmLabel="Ayrıl"
            triggerVariant="outline"
            triggerSize="default"
            trigger={
              <>
                <LogOut aria-hidden />
                Çalışma alanından ayrıl
              </>
            }
          />
        </CardContent>
      </Card>

      {isOwner ? (
        <Card className="ring-destructive/30">
          <CardHeader>
            <CardTitle className="text-destructive">Çalışma alanını sil</CardTitle>
            <CardDescription>
              Tüm üyeler, mesajlar, görevler, dosyalar, dokümanlar ve etkinlikler kalıcı olarak
              silinir. Bu işlem geri alınamaz.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DeleteWorkspaceForm slug={slug} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
