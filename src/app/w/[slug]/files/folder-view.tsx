import Link from "next/link";
import { FilePlus2, FolderOpen } from "lucide-react";

import { FilesBreadcrumbs } from "@/components/files/breadcrumbs";
import { fileKind, formatBytes, ItemIcon } from "@/components/files/file-meta";
import { FileThumbnail } from "@/components/files/file-thumbnail";
import { FileDropZone, FileUploader, UploadProvider } from "@/components/files/file-uploader";
import { ItemActions, type ActionItem } from "@/components/files/item-actions";
import { NewFolderDialog } from "@/components/files/new-folder-dialog";
import { EmptyState } from "@/components/empty-state";
import { InternalBadge } from "@/components/internal-toggle";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDate } from "@/lib/format";
import { canModify, isGuest } from "@/lib/roles";
import { thumbnailEligible } from "@/lib/storage/inline";
import type { TenantContext } from "@/lib/tenant-context";
import { FOLDER_ITEMS_MAX, listFolderContents, listFolderTree } from "@/server/files";
import { listProjectOptions } from "@/server/projects";

import { orNotFound } from "./load";
import { documentHref, fileViewHref, folderHref, newDocumentHref } from "./paths";

type Person = { id: string; name: string | null; email: string; image: string | null };

type Row = {
  key: string;
  item: ActionItem;
  href: string;
  icon: React.ReactNode;
  meta: string;
  person: Person;
  date: Date;
  ownerId: string;
  /** Team-only folder or document: shows the "Ekip içi" badge. */
  internal?: boolean;
};

function Rows({ slug, ctx, rows, folders }: {
  slug: string;
  ctx: TenantContext;
  rows: Row[];
  folders: { id: string; name: string; parentId: string | null }[];
}) {
  return (
    <ul className="divide-y">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
          {r.icon}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <Link href={r.href} className="block min-w-0 truncate text-sm font-medium hover:underline">
                {r.item.name}
              </Link>
              {r.internal ? <InternalBadge className="shrink-0" /> : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {r.meta}
              <span className="sm:hidden">
                {" "}
                · {displayName(r.person)} · {formatDate(r.date, "d MMM yyyy")}
              </span>
            </p>
          </div>
          <div className="hidden w-40 min-w-0 items-center gap-2 sm:flex">
            <UserAvatar user={r.person} size="sm" />
            <span className="truncate text-xs text-muted-foreground">{displayName(r.person)}</span>
          </div>
          <time
            dateTime={r.date.toISOString()}
            className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground sm:block"
          >
            {formatDate(r.date, "d MMM yyyy")}
          </time>
          <div className="flex w-7 shrink-0 justify-end pointer-coarse:w-10">
            <ItemActions
              slug={slug}
              item={r.item}
              canModify={canModify(ctx, r.ownerId)}
              canSetInternal={!isGuest(ctx.role)}
              folders={folders}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Shared view for /files (root) and /files/[folderId]. */
export async function FolderView({ slug, ctx, folderId }: { slug: string; ctx: TenantContext; folderId: string | null }) {
  const [{ folder, breadcrumbs, folders, files, documents, truncated }, tree] = await orNotFound(() =>
    Promise.all([listFolderContents(ctx, folderId), listFolderTree(ctx)]),
  );
  const projects = folderId ? [] : await listProjectOptions(ctx);

  const rows: Row[] = [
    ...folders.map<Row>((f) => ({
      key: `folder-${f.id}`,
      item: { kind: "folder", id: f.id, name: f.name, locationId: f.parentId, internal: f.internal },
      internal: f.internal,
      href: folderHref(slug, f.id),
      icon: <ItemIcon kind="folder" />,
      meta: f.itemCount === 0 ? "Klasör · boş" : `Klasör · ${f.itemCount} öğe`,
      person: f.createdBy,
      date: f.updatedAt,
      ownerId: f.createdById,
    })),
    ...documents.map<Row>((d) => ({
      key: `doc-${d.id}`,
      item: { kind: "document", id: d.id, name: d.title, locationId: d.folderId, internal: d.internal },
      internal: d.internal,
      href: documentHref(slug, d.id),
      icon: <ItemIcon kind="document" />,
      meta: "Doküman",
      person: d.author,
      date: d.updatedAt,
      ownerId: d.authorId,
    })),
    ...files.map<Row>((f) => ({
      key: `file-${f.id}`,
      item: { kind: "file", id: f.id, name: f.name, locationId: f.folderId },
      href: fileViewHref(slug, f.id),
      icon: thumbnailEligible(f.mimeType, f.size) ? (
        <FileThumbnail fileId={f.id} name={f.name} mimeType={f.mimeType} />
      ) : (
        <ItemIcon kind="file" mimeType={f.mimeType} name={f.name} />
      ),
      meta: `${fileKind(f.mimeType, f.name).label} · ${formatBytes(f.size)}`,
      person: f.uploadedBy,
      date: f.createdAt,
      ownerId: f.uploadedById,
    })),
  ];

  const currentId = folder?.id ?? null;
  const folderEditable = folder ? canModify(ctx, folder.createdById) : false;

  return (
    <UploadProvider slug={slug} folderId={currentId}>
      <div className="space-y-6">
        <PageHeader
          title={folder?.name ?? "Dosyalar"}
          description={
            folder ? undefined : "Dosyaları yükleyin, dokümanlar yazın ve klasörlerle düzenleyin."
          }
          actions={
            <>
              {folder && folderEditable ? (
                <ItemActions
                  slug={slug}
                  item={{
                    kind: "folder",
                    id: folder.id,
                    name: folder.name,
                    locationId: folder.parentId,
                    internal: folder.internal,
                  }}
                  canSetInternal={!isGuest(ctx.role)}
                  canModify
                  folders={tree}
                  current
                />
              ) : null}
              <NewFolderDialog slug={slug} parentId={currentId} projects={projects} canSetInternal={!isGuest(ctx.role)} />
              <Link href={newDocumentHref(slug, currentId)} className={buttonVariants({ variant: "outline" })}>
                <FilePlus2 aria-hidden />
                Yeni doküman
              </Link>
              <FileUploader />
            </>
          }
        />

        <FilesBreadcrumbs slug={slug} crumbs={breadcrumbs} />

        <FileDropZone>
          {rows.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title={folder ? "Bu klasör boş" : "Henüz dosya yok"}
              description="Dosya yükleyin (ya da buraya sürükleyip bırakın), bir doküman yazın veya içerikleri gruplamak için klasör oluşturun. Dosya başına sınır 25 MB."
            />
          ) : (
            <Card className="gap-0 overflow-hidden py-0">
              <div className="hidden items-center gap-3 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground sm:flex">
                <span className="w-9 shrink-0" />
                <span className="flex-1">Ad</span>
                <span className="w-40">Ekleyen</span>
                <span className="w-24 text-right">Tarih</span>
                <span className="w-7 shrink-0" />
              </div>
              <Rows slug={slug} ctx={ctx} rows={rows} folders={tree} />
              {truncated ? (
                <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
                  Bu klasörde çok fazla öğe var; her türden ilk {FOLDER_ITEMS_MAX} öğe (ada göre) gösteriliyor. Diğerlerini
                  bulmak için aramayı kullanın ya da alt klasörlere taşıyın.
                </p>
              ) : null}
            </Card>
          )}
        </FileDropZone>
      </div>
    </UploadProvider>
  );
}
