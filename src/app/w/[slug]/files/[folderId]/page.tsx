import type { Metadata } from "next";

import { requireWorkspace } from "@/lib/tenant";

import { FolderView } from "../folder-view";

export const metadata: Metadata = { title: "Dosyalar" };

export default async function FolderPage({
  params,
}: {
  params: Promise<{ slug: string; folderId: string }>;
}) {
  const { slug, folderId } = await params;
  const { ctx } = await requireWorkspace(slug);
  // FolderView renders a 404 for folders outside this workspace.
  return <FolderView slug={slug} ctx={ctx} folderId={folderId} />;
}
