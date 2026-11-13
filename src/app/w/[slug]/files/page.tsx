import type { Metadata } from "next";

import { requireWorkspace } from "@/lib/tenant";

import { FolderView } from "./folder-view";

export const metadata: Metadata = { title: "Dosyalar" };

export default async function FilesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  return <FolderView slug={slug} ctx={ctx} folderId={null} />;
}
