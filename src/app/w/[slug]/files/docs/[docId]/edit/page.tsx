import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FilesBreadcrumbs } from "@/components/files/breadcrumbs";
import { DocumentForm } from "@/components/files/document-form";
import { PageHeader } from "@/components/page-header";
import { canModify, isGuest } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { getDocument } from "@/server/files";

import { orNotFound } from "../../../load";
import { documentHref } from "../../../paths";

export const metadata: Metadata = { title: "Dokümanı düzenle" };

export default async function EditDocumentPage({
  params,
}: {
  params: Promise<{ slug: string; docId: string }>;
}) {
  const { slug, docId } = await params;
  const { ctx } = await requireWorkspace(slug);
  const { document, breadcrumbs } = await orNotFound(() => getDocument(ctx, docId));
  // Members can only edit their own documents (the action re-checks).
  if (!canModify(ctx, document.authorId)) notFound();

  return (
    <div className="space-y-6">
      <PageHeader title="Dokümanı düzenle" />
      <FilesBreadcrumbs slug={slug} crumbs={breadcrumbs} linkLast />
      <DocumentForm
        slug={slug}
        folderId={document.folderId}
        document={{ id: document.id, title: document.title, content: document.content, internal: document.internal }}
        canSetInternal={!isGuest(ctx.role)}
        cancelHref={documentHref(slug, document.id)}
      />
    </div>
  );
}
