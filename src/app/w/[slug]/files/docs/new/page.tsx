import type { Metadata } from "next";

import { FilesBreadcrumbs } from "@/components/files/breadcrumbs";
import { DocumentForm } from "@/components/files/document-form";
import { PageHeader } from "@/components/page-header";
import { isGuest } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { getFolderPath } from "@/server/files";

import { orNotFound } from "../../load";
import { folderHref } from "../../paths";

export const metadata: Metadata = { title: "Yeni doküman" };

export default async function NewDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ folder?: string | string[] }>;
}) {
  const { slug } = await params;
  const { folder } = await searchParams;
  const { ctx } = await requireWorkspace(slug);
  const folderId = typeof folder === "string" && folder ? folder : null;
  const crumbs = folderId ? await orNotFound(() => getFolderPath(ctx, folderId)) : [];

  return (
    <div className="space-y-6">
      <PageHeader title="Yeni doküman" description="Basit bir metin dokümanı. Satır sonları korunur." />
      <FilesBreadcrumbs slug={slug} crumbs={crumbs} linkLast />
      <DocumentForm
        slug={slug}
        folderId={folderId}
        cancelHref={folderHref(slug, folderId)}
        canSetInternal={!isGuest(ctx.role)}
      />
    </div>
  );
}
