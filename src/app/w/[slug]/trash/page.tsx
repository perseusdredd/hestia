import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  CalendarDays,
  CheckSquare,
  File as FileIcon,
  FileText,
  Folder,
  ListTodo,
  MessageSquare,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { format } from "date-fns";
import { tr } from "date-fns/locale";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { TrashRowActions } from "@/components/trash/trash-row-actions";
import { requireWorkspace } from "@/lib/tenant";
import { hasRole, isGuest } from "@/lib/roles";
import { listTrash, TRASH_KIND_LABELS, TRASH_RETENTION_DAYS, type TrashKind } from "@/server/trash";

export const metadata: Metadata = { title: "Çöp kutusu" };

const ICONS: Record<TrashKind, LucideIcon> = {
  post: MessageSquare,
  todoItem: CheckSquare,
  todoList: ListTodo,
  event: CalendarDays,
  file: FileIcon,
  document: FileText,
  folder: Folder,
};

const day = (d: Date) => format(d, "d MMMM yyyy", { locale: tr });

export default async function TrashPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  if (isGuest(ctx.role)) notFound(); // team-only page
  const items = await listTrash(ctx);
  const admin = hasRole(ctx.role, "ADMIN");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Çöp kutusu"
        description={`Silinen öğeler ${TRASH_RETENTION_DAYS} gün burada kalır, sonra kalıcı olarak silinir. ${
          admin ? "Yönetici olarak herkesin öğelerini görürsünüz." : "Yalnızca kendi öğelerinizi görürsünüz."
        }`}
      />

      {items.length === 0 ? (
        <EmptyState
          icon={Trash2}
          title="Çöp kutusu boş"
          description="Sildiğiniz mesaj, görev, dosya, doküman ve etkinlikler burada görünür ve geri yüklenebilir."
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card" aria-label="Silinen öğeler">
          {items.map((item) => {
            const Icon = ICONS[item.kind];
            const who = item.deletedBy ? item.deletedBy.name?.trim() || item.deletedBy.email : null;
            return (
              <li key={`${item.kind}:${item.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border">
                  <Icon className="size-4" aria-hidden />
                </div>
                <div className="min-w-0 flex-1 basis-56">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {TRASH_KIND_LABELS[item.kind]}
                    {item.detail ? ` · ${item.detail}` : ""}
                    {` · ${day(item.deletedAt)} tarihinde${who ? ` ${who} tarafından` : ""} silindi`}
                    {` · ${day(item.purgeAt)} tarihinde kalıcı silinir`}
                  </p>
                </div>
                <TrashRowActions slug={slug} kind={item.kind} id={item.id} title={item.title} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
