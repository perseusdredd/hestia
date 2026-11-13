/** URL helpers for the Files module (pure; safe on client and server). */
export function folderHref(slug: string, folderId?: string | null): string {
  return folderId ? `/w/${slug}/files/${folderId}` : `/w/${slug}/files`;
}

export function documentHref(slug: string, documentId: string): string {
  return `/w/${slug}/files/docs/${documentId}`;
}

export function newDocumentHref(slug: string, folderId?: string | null): string {
  return folderId ? `/w/${slug}/files/docs/new?folder=${encodeURIComponent(folderId)}` : `/w/${slug}/files/docs/new`;
}

export function downloadHref(fileId: string): string {
  return `/api/files/${fileId}`;
}

/** Inline (preview) endpoint; only answers for allow-listed, sniffed types. */
export function inlineHref(fileId: string): string {
  return `/api/files/${fileId}/inline`;
}

export function fileViewHref(slug: string, fileId: string): string {
  return `/w/${slug}/files/view/${fileId}`;
}
