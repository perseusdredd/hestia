"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { formString, toActionState, type ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/tenant";
import { ServiceError } from "@/server/errors";
import {
  completeUpload,
  createDocument,
  createFolder,
  createPendingUpload,
  deleteDocument,
  deleteFile,
  deleteFolder,
  moveDocument,
  moveFile,
  moveFolder,
  renameFile,
  renameFolder,
  updateDocument,
  type PendingUpload,
} from "@/server/files";

import { documentHref, folderHref } from "./paths";

// Every action resolves the workspace from the slug and the session first;
// workspace ids, author ids and roles are never taken from the client.

function revalidate(slug: string) {
  revalidatePath(`/w/${slug}/files`, "layout");
}

function badKind(): never {
  throw new ServiceError("VALIDATION", "Geçersiz öğe türü.");
}

export async function createFolderAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: formString(formData, "name"), projectId: formString(formData, "projectId") };
  try {
    const { ctx } = await requireWorkspace(slug);
    await createFolder(ctx, {
      name: values.name,
      parentId: formString(formData, "parentId"),
      projectId: values.projectId,
    });
    revalidate(slug);
    return { ok: true, message: "Klasör oluşturuldu." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function renameItemAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { name: formString(formData, "name") };
  try {
    const { ctx } = await requireWorkspace(slug);
    const input = { id: formString(formData, "id"), name: values.name };
    const kind = formString(formData, "kind");
    if (kind === "folder") await renameFolder(ctx, input);
    else if (kind === "file") await renameFile(ctx, input);
    else badKind();
    revalidate(slug);
    return { ok: true, message: "Ad güncellendi." };
  } catch (e) {
    return { ...toActionState(e), values };
  }
}

export async function moveItemAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const input = {
      id: formString(formData, "id"),
      targetFolderId: formString(formData, "targetFolderId"),
    };
    const kind = formString(formData, "kind");
    if (kind === "folder") await moveFolder(ctx, input);
    else if (kind === "file") await moveFile(ctx, input);
    else if (kind === "document") await moveDocument(ctx, input);
    else badKind();
    revalidate(slug);
    return { ok: true, message: "Taşındı." };
  } catch (e) {
    return toActionState(e);
  }
}

export async function deleteItemAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const id = formString(formData, "id");
    const kind = formString(formData, "kind");
    if (kind === "folder") await deleteFolder(ctx, id);
    else if (kind === "file") await deleteFile(ctx, id);
    else if (kind === "document") await deleteDocument(ctx, id);
    else badKind();
    revalidate(slug);
    return { ok: true, message: "Silindi." };
  } catch (e) {
    return toActionState(e);
  }
}

/** Delete the folder that is currently open, then go to its parent. */
export async function deleteCurrentFolderAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let parentId: string | null;
  try {
    const { ctx } = await requireWorkspace(slug);
    ({ parentId } = await deleteFolder(ctx, formString(formData, "id")));
    revalidate(slug);
  } catch (e) {
    return toActionState(e);
  }
  redirect(folderHref(slug, parentId));
}

/** Upload step 1 (called directly from the uploader, not via a form). */
export async function startUploadAction(
  slug: string,
  input: { name: string; size: number; type: string; folderId: string | null },
): Promise<ActionState<PendingUpload>> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const pending = await createPendingUpload(ctx, input);
    return { ok: true, data: pending };
  } catch (e) {
    return toActionState<PendingUpload>(e);
  }
}

/** Upload step 3: verify the stored object and create the File row. */
export async function completeUploadAction(
  slug: string,
  token: string,
): Promise<ActionState<{ id: string }>> {
  try {
    const { ctx } = await requireWorkspace(slug);
    const file = await completeUpload(ctx, token);
    revalidate(slug);
    return { ok: true, data: { id: file.id } };
  } catch (e) {
    return toActionState<{ id: string }>(e);
  }
}

export async function createDocumentAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { title: formString(formData, "title"), content: formString(formData, "content") };
  let id: string;
  try {
    const { ctx } = await requireWorkspace(slug);
    const doc = await createDocument(ctx, { ...values, folderId: formString(formData, "folderId") });
    id = doc.id;
    revalidate(slug);
  } catch (e) {
    return { ...toActionState(e), values };
  }
  redirect(documentHref(slug, id));
}

export async function updateDocumentAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = { title: formString(formData, "title"), content: formString(formData, "content") };
  const id = formString(formData, "id");
  try {
    const { ctx } = await requireWorkspace(slug);
    await updateDocument(ctx, { id, ...values });
    revalidate(slug);
  } catch (e) {
    return { ...toActionState(e), values };
  }
  redirect(documentHref(slug, id));
}

/** Delete from the document page, then go back to its folder. */
export async function deleteDocumentAction(
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let folderId: string | null;
  try {
    const { ctx } = await requireWorkspace(slug);
    ({ folderId } = await deleteDocument(ctx, formString(formData, "id")));
    revalidate(slug);
  } catch (e) {
    return toActionState(e);
  }
  redirect(folderHref(slug, folderId));
}
