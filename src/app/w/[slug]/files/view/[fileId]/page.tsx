import { cache } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";

import { CommentThread } from "@/components/comments/comment-thread";
import { FilesBreadcrumbs } from "@/components/files/breadcrumbs";
import { FileVersions } from "@/components/files/file-versions";
import { ItemActions } from "@/components/files/item-actions";
import { fileKind, formatBytes } from "@/components/files/file-meta";
import { PdfPreview } from "@/components/files/pdf-preview";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDateTime } from "@/lib/format";
import { canModify, isGuest } from "@/lib/roles";
import { TEXT_PREVIEW_MAX_BYTES } from "@/lib/storage/inline";
import { requireWorkspace } from "@/lib/tenant";
import { getFilePreview, listFileVersions, listFolderTree, type FilePreview } from "@/server/files";

import { orNotFound } from "../../load";
import { downloadHref, folderHref, inlineHref } from "../../paths";

type Params = Promise<{ slug: string; fileId: string }>;

// One storage read per request, shared by generateMetadata and the page.
const load = cache(async (slug: string, fileId: string) => {
  const { ctx } = await requireWorkspace(slug);
  const [preview, versions, tree] = await orNotFound(() =>
    Promise.all([getFilePreview(ctx, fileId), listFileVersions(ctx, fileId), listFolderTree(ctx)]),
  );
  const mayModify = !isGuest(ctx.role) && canModify(ctx, preview.file.uploadedById);
  return { ...preview, versions, tree, mayModify };
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, fileId } = await params;
  const { file } = await load(slug, fileId);
  return { title: file.name };
}

function PreviewBody({ preview, fileId, name, mimeType }: {
  preview: FilePreview;
  fileId: string;
  name: string;
  mimeType: string;
}) {
  const src = inlineHref(fileId);
  switch (preview.kind) {
    case "image":
      return (
        <div className="flex justify-center rounded-lg bg-muted p-2">
          <Image
            src={src}
            alt={name}
            width={1600}
            height={1200}
            unoptimized
            className="h-auto max-h-[70vh] w-auto max-w-full rounded-md object-contain"
          />
        </div>
      );
    case "pdf":
      return <PdfPreview src={src} name={name} />;
    case "audio":
      return (
        <audio controls preload="metadata" src={src} className="w-full">
          Tarayıcınız ses oynatmayı desteklemiyor.
        </audio>
      );
    case "video":
      return (
        <video
          controls
          preload="metadata"
          playsInline
          src={src}
          className="max-h-[70vh] w-full rounded-lg bg-muted"
        >
          Tarayıcınız video oynatmayı desteklemiyor.
        </video>
      );
    case "text":
      return (
        <div className="space-y-2">
          <pre
            tabIndex={0}
            aria-label={`${name} içeriği`}
            className="max-h-[70vh] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:text-sm"
          >
            {preview.text || " "}
          </pre>
          {preview.truncated ? (
            <p className="text-xs text-muted-foreground">
              Önizleme ilk {formatBytes(TEXT_PREVIEW_MAX_BYTES)} ile sınırlı. Tamamı için dosyayı indirin.
            </p>
          ) : null}
        </div>
      );
    case "none":
      return (
        <EmptyState
          icon={fileKind(mimeType, name).icon}
          title="Önizleme yok"
          description="Bu dosya türü tarayıcıda güvenle gösterilemiyor. İndirerek açabilirsiniz."
        />
      );
  }
}

export default async function FileViewPage({ params }: { params: Params }) {
  const { slug, fileId } = await params;
  const { ctx } = await requireWorkspace(slug);
  const { file, breadcrumbs, preview, versions, tree, mayModify } = await load(slug, fileId);
  const kind = fileKind(file.mimeType, file.name);
  const parentHref = folderHref(slug, file.folderId);

  return (
    <div className="space-y-6">
      <PageHeader
        title={file.name}
        description={`${kind.label} · ${formatBytes(file.size)}`}
        actions={
          <>
            <Link href={parentHref} className={buttonVariants({ variant: "outline" })}>
              <ArrowLeft aria-hidden />
              Klasöre dön
            </Link>
            <a href={downloadHref(file.id)} download className={buttonVariants()}>
              <Download aria-hidden />
              İndir
            </a>
            {mayModify ? (
              <ItemActions
                slug={slug}
                item={{ kind: "file", id: file.id, name: file.name, locationId: file.folderId }}
                canModify
                folders={tree}
              />
            ) : null}
          </>
        }
      />
      <FilesBreadcrumbs slug={slug} crumbs={breadcrumbs} linkLast />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-label="Önizleme" className="min-w-0">
          <PreviewBody preview={preview} fileId={file.id} name={file.name} mimeType={file.mimeType} />
        </section>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Dosya bilgileri</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Ad</dt>
                <dd className="break-words">{file.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Tür</dt>
                <dd className="break-all">
                  {kind.label} <span className="text-muted-foreground">({file.mimeType})</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Boyut</dt>
                <dd>{formatBytes(file.size)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Yükleyen</dt>
                <dd className="flex min-w-0 items-center gap-2">
                  <UserAvatar user={file.uploadedBy} size="sm" />
                  <span className="truncate">{displayName(file.uploadedBy)}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Yüklenme tarihi</dt>
                <dd>
                  <time dateTime={file.createdAt.toISOString()}>{formatDateTime(file.createdAt)}</time>
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card className="h-fit lg:col-start-2">
          <CardHeader>
            <CardTitle>Sürümler</CardTitle>
          </CardHeader>
          <CardContent>
            <FileVersions
              slug={slug}
              fileId={file.id}
              canUpload={mayModify}
              versions={versions.map((v) => ({
                id: v.id,
                version: v.version,
                size: v.size,
                current: v.current,
                createdAt: v.createdAt.toISOString(),
                uploadedBy: v.uploadedBy,
              }))}
            />
          </CardContent>
        </Card>
      </div>
      <CommentThread slug={slug} ctx={ctx} subject={{ type: "file", id: file.id }} />
    </div>
  );
}
