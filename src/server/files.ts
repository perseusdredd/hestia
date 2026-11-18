import { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_TYPES } from "@/lib/pusher/chat-protocol";
import { canModify, hasRole } from "@/lib/roles";
import {
  decodeTextPreview,
  generateStorageKey,
  getStorage,
  inlineHeaders,
  inlineSpec,
  isTextPreviewable,
  keyBelongsToWorkspace,
  MAX_FILE_SIZE,
  normalizeMimeType,
  parseRange,
  sniffMatches,
  SNIFF_BYTES,
  StorageExistsError,
  StorageLimitError,
  TEXT_PREVIEW_MAX_BYTES,
  type InlineKind,
  type StorageDriver,
} from "@/lib/storage";
import {
  signUploadToken,
  UPLOAD_TOKEN_TTL_MS,
  verifyUploadToken,
  type UploadTokenPayload,
} from "@/lib/storage/upload-token";
import type { TenantContext } from "@/lib/tenant-context";
import {
  documentActivityPath,
  folderActivityPath,
  forgetActivity,
  recordActivity,
} from "@/server/activity";
import { forbidden, notFound, parseInput, ServiceError } from "@/server/errors";

/*
 * Files & Docs service. Every ctx-first function scopes all reads and writes by
 * ctx.workspaceId. Exceptions (no ctx yet, they resolve it): authorizeFileAccess()
 * and acceptLocalUpload(), used by route handlers that only know a file id or a
 * signed upload token - both re-check membership in the database. The download
 * and inline routes call authorizeFileAccess() and then the ctx-first
 * getFileDownload() / getFileInline().
 */

export const MAX_FOLDER_DEPTH = 20;
export { MAX_FILE_SIZE };

type Tx = Prisma.TransactionClient;

const userSelect = { select: { id: true, name: true, email: true, image: true } } as const;

const idSchema = z.string().trim().min(1, "Geçersiz kayıt.").max(64, "Geçersiz kayıt.");
const optionalFolderId = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() ? v.trim() : null))
  .pipe(z.string().max(64, "Geçersiz klasör.").nullable());

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const itemName = (label: string, max: number) =>
  z
    .string()
    .transform((v) => v.replace(CONTROL_CHARS, "").trim())
    .pipe(
      z
        .string()
        .min(1, `${label} gerekli.`)
        .max(max, `${label} en fazla ${max} karakter olabilir.`)
        .refine((v) => v !== "." && v !== "..", `${label} geçersiz.`),
    );

const folderNameSchema = itemName("Klasör adı", 120).refine(
  (v) => !/[\\/]/.test(v),
  "Klasör adı / veya \\ içeremez.",
);
const fileNameSchema = z
  .string()
  // Browsers may report a path; keep only the last segment.
  .transform((v) => v.split(/[\\/]/).pop() ?? "")
  .pipe(itemName("Dosya adı", 200));
const docTitleSchema = itemName("Başlık", 200);
const docContentSchema = z
  .string()
  .max(100_000, "Doküman çok uzun (en fazla 100.000 karakter).")
  .transform((v) => v.replace(/\r\n?/g, "\n"));

const createFolderSchema = z.object({ name: folderNameSchema, parentId: optionalFolderId });
const renameSchema = (name: z.ZodType<string>) => z.object({ id: idSchema, name });
const moveSchema = z.object({ id: idSchema, targetFolderId: optionalFolderId });
const pendingUploadSchema = z.object({
  name: fileNameSchema,
  size: z.coerce
    .number()
    .int("Geçersiz dosya boyutu.")
    .min(0, "Geçersiz dosya boyutu.")
    .max(MAX_FILE_SIZE, "Dosya en fazla 25 MB olabilir."),
  type: z.string().max(255).optional().nullable(),
  folderId: optionalFolderId,
});
const documentSchema = z.object({
  title: docTitleSchema,
  content: docContentSchema,
  folderId: optionalFolderId,
});
const updateDocumentSchema = z.object({ id: idSchema, title: docTitleSchema, content: docContentSchema });

// ------------------------------------------------------------ helpers ----

/** Serialises folder-tree mutations per workspace (no row lock on Workspace). */
async function lockTree(tx: Tx, workspaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"hestia:folders:" + workspaceId}))`;
}

async function findFolder(client: Tx | typeof db, ctx: TenantContext, id: string) {
  const folder = await client.folder.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null } });
  if (!folder) throw notFound("Klasör bulunamadı.");
  return folder;
}

/** Ancestor chain root-first, ending with `folderId` itself. */
async function ancestorChain(client: Tx | typeof db, ctx: TenantContext, folderId: string) {
  // One recursive query instead of one query per level. Every step stays in
  // ctx's workspace; the depth bound guards against a corrupted (cyclic) tree.
  const rows = await client.$queryRaw<{ id: string; name: string; parentId: string | null }[]>`
    WITH RECURSIVE chain AS (
      SELECT id, name, "parentId", 0 AS depth
      FROM "Folder"
      WHERE id = ${folderId} AND "workspaceId" = ${ctx.workspaceId}
      UNION ALL
      SELECT f.id, f.name, f."parentId", chain.depth + 1
      FROM "Folder" f
      JOIN chain ON f.id = chain."parentId"
      WHERE f."workspaceId" = ${ctx.workspaceId} AND chain.depth < ${MAX_FOLDER_DEPTH + 5}
    )
    SELECT id, name, "parentId" FROM chain ORDER BY depth DESC`;
  return rows;
}

/** All descendant folders of `rootId` (excluding it), breadth-first. */
async function descendantFolders(client: Tx | typeof db, ctx: TenantContext, rootId: string) {
  const out: { id: string; parentId: string | null; createdById: string; depth: number }[] = [];
  let frontier = [rootId];
  let depth = 0;
  while (frontier.length && depth <= MAX_FOLDER_DEPTH + 5) {
    depth += 1;
    const children = await client.folder.findMany({
      where: { workspaceId: ctx.workspaceId, parentId: { in: frontier }, deletedAt: null },
      select: { id: true, parentId: true, createdById: true },
    });
    out.push(...children.map((c) => ({ ...c, depth })));
    frontier = children.map((c) => c.id);
  }
  return out;
}

async function assertUniqueFolderName(
  tx: Tx,
  ctx: TenantContext,
  parentId: string | null,
  name: string,
  exceptId?: string,
) {
  const clash = await tx.folder.findFirst({
    where: {
      workspaceId: ctx.workspaceId,
      deletedAt: null,
      parentId,
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) {
    throw new ServiceError("CONFLICT", "Bu konumda aynı adda bir klasör zaten var.", {
      name: ["Bu konumda aynı adda bir klasör zaten var."],
    });
  }
}

export async function deleteObjects(storage: StorageDriver, keys: string[]) {
  const results = await Promise.allSettled(keys.map((k) => storage.delete(k)));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[files] could not delete storage object ${keys[i]}`, r.reason);
    }
  });
}

// ------------------------------------------------------------ reading ----

export type FolderListItem = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdById: string;
  createdBy: { id: string; name: string | null; email: string; image: string | null };
  itemCount: number;
};

/** Rows loaded per kind (folders, files, documents) for one folder view. */
export const FOLDER_ITEMS_MAX = 500;

/**
 * Contents of a folder (`folderId` null = workspace root) plus breadcrumbs.
 * At most FOLDER_ITEMS_MAX rows of each kind (first by name); `truncated`
 * says that more exist.
 * Throws NOT_FOUND for folders outside ctx.workspaceId.
 */
export async function listFolderContents(ctx: TenantContext, folderId: string | null) {
  const id = parseInput(optionalFolderId, folderId);
  const folder = id ? await findFolder(db, ctx, id) : null;
  const breadcrumbs = id ? (await ancestorChain(db, ctx, id)).map(({ id, name }) => ({ id, name })) : [];
  const where = { workspaceId: ctx.workspaceId, deletedAt: null, ...(id ? { folderId: id } : { folderId: null }) };
  // Chat photos are not part of the Files browser (documents have no such flag).
  const fileWhere = { ...where, fromChat: false };

  const [folderRows, files, documents] = await Promise.all([
    db.folder.findMany({
      where: { workspaceId: ctx.workspaceId, parentId: id, deletedAt: null },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: FOLDER_ITEMS_MAX + 1,
      include: {
        createdBy: userSelect,
        _count: {
          select: {
            children: { where: { deletedAt: null } },
            files: { where: { deletedAt: null } },
            documents: { where: { deletedAt: null } },
          },
        },
      },
    }),
    db.file.findMany({
      where: fileWhere,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: FOLDER_ITEMS_MAX + 1,
      include: { uploadedBy: userSelect },
    }),
    db.document.findMany({
      where,
      orderBy: [{ title: "asc" }, { id: "asc" }],
      take: FOLDER_ITEMS_MAX + 1,
      select: {
        id: true,
        title: true,
        authorId: true,
        createdAt: true,
        updatedAt: true,
        folderId: true,
        author: userSelect,
      },
    }),
  ]);

  const truncated = [folderRows, files, documents].some((rows) => rows.length > FOLDER_ITEMS_MAX);
  for (const rows of [folderRows, files, documents]) rows.splice(FOLDER_ITEMS_MAX);

  const byName = (a: string, b: string) => a.localeCompare(b, "tr", { sensitivity: "base" });
  const folders: FolderListItem[] = folderRows
    .map(({ _count, ...f }) => ({
      ...f,
      itemCount: _count.children + _count.files + _count.documents,
    }))
    .sort((a, b) => byName(a.name, b.name));
  files.sort((a, b) => byName(a.name, b.name));
  documents.sort((a, b) => byName(a.title, b.title));

  return { folder, breadcrumbs, folders, files, documents, truncated };
}

/** Breadcrumbs (root-first) for a folder; NOT_FOUND outside ctx.workspaceId. */
export async function getFolderPath(ctx: TenantContext, folderId: string) {
  const id = parseInput(idSchema, folderId);
  await findFolder(db, ctx, id);
  return (await ancestorChain(db, ctx, id)).map(({ id, name }) => ({ id, name }));
}

export type RecentItem =
  | {
      kind: "file";
      id: string;
      name: string;
      mimeType: string;
      size: number;
      folderId: string | null;
      at: Date;
      by: { id: string; name: string | null; email: string; image: string | null };
    }
  | {
      kind: "document";
      id: string;
      name: string;
      folderId: string | null;
      at: Date;
      by: { id: string; name: string | null; email: string; image: string | null };
    };

/** Newest files (by upload) and documents (by last edit) across all folders, newest first. */
export async function listRecentItems(ctx: TenantContext, opts: { take?: number } = {}): Promise<RecentItem[]> {
  const take = Math.min(Math.max(opts.take ?? 6, 1), 50);
  const [files, documents] = await Promise.all([
    db.file.findMany({
      where: { workspaceId: ctx.workspaceId, fromChat: false, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        name: true,
        mimeType: true,
        size: true,
        folderId: true,
        createdAt: true,
        uploadedBy: userSelect,
      },
    }),
    db.document.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take,
      select: { id: true, title: true, folderId: true, updatedAt: true, author: userSelect },
    }),
  ]);
  const items: RecentItem[] = [
    ...files.map((f) => ({
      kind: "file" as const,
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size,
      folderId: f.folderId,
      at: f.createdAt,
      by: f.uploadedBy,
    })),
    ...documents.map((d) => ({
      kind: "document" as const,
      id: d.id,
      name: d.title,
      folderId: d.folderId,
      at: d.updatedAt,
      by: d.author,
    })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, take);
}

/** Every folder in the workspace (for move pickers). */
export async function listFolderTree(ctx: TenantContext) {
  return db.folder.findMany({
    where: { workspaceId: ctx.workspaceId, deletedAt: null },
    select: { id: true, name: true, parentId: true },
    orderBy: { name: "asc" },
  });
}

// ------------------------------------------------------------ folders ----

export async function createFolder(ctx: TenantContext, input: unknown) {
  const data = parseInput(createFolderSchema, input);
  const folder = await db.$transaction(async (tx) => {
    await lockTree(tx, ctx.workspaceId);
    if (data.parentId) {
      await findFolder(tx, ctx, data.parentId);
      const chain = await ancestorChain(tx, ctx, data.parentId);
      if (chain.length >= MAX_FOLDER_DEPTH) {
        throw new ServiceError("VALIDATION", "Klasörler en fazla 20 seviye iç içe olabilir.");
      }
    }
    await assertUniqueFolderName(tx, ctx, data.parentId, data.name);
    return tx.folder.create({
      data: {
        workspaceId: ctx.workspaceId,
        parentId: data.parentId,
        createdById: ctx.userId,
        name: data.name,
      },
    });
  });
  await recordActivity(ctx, {
    type: "FOLDER_CREATED",
    title: folder.name,
    path: folderActivityPath(folder.id),
    subject: { type: "folder", id: folder.id },
  }); // after commit
  return folder;
}

export async function renameFolder(ctx: TenantContext, input: unknown) {
  const data = parseInput(renameSchema(folderNameSchema), input);
  return db.$transaction(async (tx) => {
    await lockTree(tx, ctx.workspaceId);
    const folder = await findFolder(tx, ctx, data.id);
    if (!canModify(ctx, folder.createdById)) throw forbidden();
    await assertUniqueFolderName(tx, ctx, folder.parentId, data.name, folder.id);
    return tx.folder.update({ where: { id: folder.id }, data: { name: data.name } });
  });
}

/**
 * Move a folder under `targetFolderId` (null = root). The target must be in
 * the same workspace and must not be the folder itself or one of its
 * descendants (no cycles).
 */
export async function moveFolder(ctx: TenantContext, input: unknown) {
  const data = parseInput(moveSchema, input);
  return db.$transaction(async (tx) => {
    await lockTree(tx, ctx.workspaceId);
    const folder = await findFolder(tx, ctx, data.id);
    if (!canModify(ctx, folder.createdById)) throw forbidden();
    if (folder.parentId === data.targetFolderId) return folder;

    let targetDepth = 0;
    if (data.targetFolderId) {
      if (data.targetFolderId === folder.id) {
        throw new ServiceError("VALIDATION", "Bir klasör kendi içine taşınamaz.");
      }
      await findFolder(tx, ctx, data.targetFolderId);
      const chain = await ancestorChain(tx, ctx, data.targetFolderId);
      if (chain.some((f) => f.id === folder.id)) {
        throw new ServiceError("VALIDATION", "Bir klasör kendi alt klasörlerinden birine taşınamaz.");
      }
      targetDepth = chain.length;
    }
    const descendants = await descendantFolders(tx, ctx, folder.id);
    const subtreeHeight = descendants.reduce((m, d) => Math.max(m, d.depth), 0) + 1;
    if (targetDepth + subtreeHeight > MAX_FOLDER_DEPTH) {
      throw new ServiceError("VALIDATION", "Klasörler en fazla 20 seviye iç içe olabilir.");
    }
    await assertUniqueFolderName(tx, ctx, data.targetFolderId, folder.name, folder.id);
    return tx.folder.update({ where: { id: folder.id }, data: { parentId: data.targetFolderId } });
  });
}

/**
 * Move a folder, its subfolders and everything inside them to the trash (soft
 * delete). Everything gets the same deletedAt, so restoring the folder brings
 * back exactly that set. Storage objects stay until the trash is purged.
 * Members may delete only folders whose whole subtree they own; ADMIN+ any.
 */
export async function deleteFolder(
  ctx: TenantContext,
  folderId: string,
  // Kept so callers can still pass a driver: objects are only removed when the trash is purged.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _storage?: StorageDriver,
) {
  const id = parseInput(idSchema, folderId);
  return db.$transaction(async (tx) => {
    await lockTree(tx, ctx.workspaceId);
    const folder = await findFolder(tx, ctx, id);
    if (!canModify(ctx, folder.createdById)) throw forbidden();

    const descendants = await descendantFolders(tx, ctx, folder.id);
    const folderIds = [folder.id, ...descendants.map((d) => d.id)];
    const scope = { workspaceId: ctx.workspaceId, deletedAt: null, folderId: { in: folderIds } };
    const [files, documents] = await Promise.all([
      tx.file.findMany({ where: scope, select: { id: true, uploadedById: true } }),
      tx.document.findMany({ where: scope, select: { id: true, authorId: true } }),
    ]);

    if (!hasRole(ctx.role, "ADMIN")) {
      const foreign =
        descendants.some((d) => d.createdById !== ctx.userId) ||
        files.some((f) => f.uploadedById !== ctx.userId) ||
        documents.some((d) => d.authorId !== ctx.userId);
      if (foreign) {
        throw forbidden(
          "Bu klasörde başka üyelere ait öğeler var. Yalnızca yöneticiler bu klasörü silebilir.",
        );
      }
    }

    // Feed rows of the folders, the files and documents in them and the
    // documents' comments (before the update: comments are found by key).
    await forgetActivity(
      ctx,
      [
        ...folderIds.map((fid) => ({ type: "folder" as const, id: fid })),
        ...files.map((f) => ({ type: "file" as const, id: f.id })),
        ...documents.map((d) => ({ type: "document" as const, id: d.id })),
      ],
      tx,
    );
    const stamp = { deletedAt: new Date(), deletedById: ctx.userId };
    await tx.file.updateMany({
      where: { id: { in: files.map((f) => f.id) }, workspaceId: ctx.workspaceId },
      data: stamp,
    });
    // Raw: updateMany would bump updatedAt, which is the "last edited" date.
    if (documents.length) {
      await tx.$executeRaw`UPDATE "Document" SET "deletedAt" = ${stamp.deletedAt}, "deletedById" = ${stamp.deletedById}
        WHERE "workspaceId" = ${ctx.workspaceId} AND id = ANY(${documents.map((d) => d.id)}::text[])`;
    }
    await tx.folder.updateMany({
      where: { id: { in: folderIds }, workspaceId: ctx.workspaceId },
      data: stamp,
    });

    return {
      parentId: folder.parentId,
      deletedFolders: folderIds.length,
      deletedFiles: files.length,
      deletedDocuments: documents.length,
    };
  });
}

/**
 * Brings a trashed folder back with everything that was trashed together with
 * it (same deletedAt: subfolders, files, documents). The parent folder must be
 * live and the name free there. Returns what was restored.
 */
export async function restoreFolderTree(ctx: TenantContext, folderId: string) {
  const id = parseInput(idSchema, folderId);
  return db.$transaction(async (tx) => {
    await lockTree(tx, ctx.workspaceId);
    const folder = await tx.folder.findFirst({
      where: { id, workspaceId: ctx.workspaceId, deletedAt: { not: null } },
    });
    if (!folder?.deletedAt) throw notFound("Klasör bulunamadı.");
    if (!canModify(ctx, folder.createdById)) throw forbidden();
    if (folder.parentId) {
      const parent = await tx.folder.findFirst({
        where: { id: folder.parentId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!parent) {
        throw new ServiceError("CONFLICT", "Üst klasör silinmiş. Önce üst klasörü geri yükleyin.");
      }
    }
    await assertUniqueFolderName(tx, ctx, folder.parentId, folder.name, folder.id);

    const together = { workspaceId: ctx.workspaceId, deletedAt: folder.deletedAt, deletedById: folder.deletedById };
    const cleared = { deletedAt: null, deletedById: null };
    const [files, documents, folders] = await Promise.all([
      tx.file.updateMany({ where: together, data: cleared }),
      // Raw: updateMany would bump updatedAt, which is the "last edited" date.
      tx.$executeRaw`UPDATE "Document" SET "deletedAt" = NULL, "deletedById" = NULL
        WHERE "workspaceId" = ${together.workspaceId} AND "deletedAt" = ${folder.deletedAt}
          AND "deletedById" IS NOT DISTINCT FROM ${folder.deletedById}`,
      tx.folder.updateMany({ where: together, data: cleared }),
    ]);
    return { folder, restoredFolders: folders.count, restoredFiles: files.count, restoredDocuments: Number(documents) };
  });
}

// -------------------------------------------------------------- files ----

async function findFile(client: Tx | typeof db, ctx: TenantContext, id: string) {
  const file = await client.file.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null } });
  if (!file) throw notFound("Dosya bulunamadı.");
  return file;
}

export type PendingUpload = {
  token: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
};

/**
 * Step 1 of an upload: validate name/size/type/folder, generate the storage
 * key on the server and return where the browser should PUT the bytes.
 */
export async function createPendingUpload(
  ctx: TenantContext,
  input: unknown,
  storage: StorageDriver = getStorage(),
): Promise<PendingUpload> {
  const data = parseInput(pendingUploadSchema, input);
  if (data.folderId) await findFolder(db, ctx, data.folderId);
  return issueUpload(ctx, data, normalizeMimeType(data.type), false, storage);
}

const chatImageUploadSchema = z.object({
  name: fileNameSchema,
  size: z.coerce
    .number()
    .int("Geçersiz dosya boyutu.")
    .min(1, "Geçersiz dosya boyutu.")
    .max(CHAT_IMAGE_MAX_BYTES, "Fotoğraf en fazla 10 MB olabilir."),
  type: z.string().max(255),
});

/**
 * Upload step 1 for a chat photo: only previewable image types, at most
 * 10 MB, never inside a folder. The resulting File is flagged fromChat and
 * stays out of the Files browser, recents and search.
 */
export async function createChatImageUpload(
  ctx: TenantContext,
  input: unknown,
  storage: StorageDriver = getStorage(),
): Promise<PendingUpload> {
  const data = parseInput(chatImageUploadSchema, input);
  const mimeType = normalizeMimeType(data.type);
  if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(mimeType)) {
    throw new ServiceError("VALIDATION", "Yalnızca JPEG, PNG, WebP veya GIF fotoğraf gönderebilirsiniz.");
  }
  return issueUpload(ctx, { name: data.name, size: data.size, folderId: null }, mimeType, true, storage);
}

async function issueUpload(
  ctx: TenantContext,
  data: { name: string; size: number; folderId: string | null },
  mimeType: string,
  chat: boolean,
  storage: StorageDriver,
): Promise<PendingUpload> {
  const key = generateStorageKey(ctx.workspaceId, data.name);
  const token = signUploadToken({
    k: key,
    w: ctx.workspaceId,
    u: ctx.userId,
    f: data.folderId,
    n: data.name,
    s: data.size,
    t: mimeType,
    e: Date.now() + UPLOAD_TOKEN_TTL_MS,
    ...(chat ? { c: true } : {}),
  });
  const target = await storage.createUploadTarget(key, {
    contentType: mimeType,
    size: data.size,
    token,
  });
  return { token, ...target };
}

function readToken(ctx: TenantContext, token: unknown): UploadTokenPayload {
  const p = verifyUploadToken(token);
  if (!p || p.w !== ctx.workspaceId || p.u !== ctx.userId || !keyBelongsToWorkspace(p.k, ctx.workspaceId)) {
    throw new ServiceError("VALIDATION", "Yükleme oturumu geçersiz veya süresi dolmuş. Lütfen tekrar deneyin.");
  }
  return p;
}

const KEY_USED_MESSAGE = "Bu yükleme oturumu zaten kullanıldı. Dosyayı yeniden yükleyin.";

/** The key was consumed but its File row is gone (deleted): refuse and drop the replayed bytes. */
async function rejectConsumedKey(storage: StorageDriver, ctx: TenantContext, key: string): Promise<never> {
  if (keyBelongsToWorkspace(key, ctx.workspaceId)) await deleteObjects(storage, [key]);
  throw new ServiceError("CONFLICT", KEY_USED_MESSAGE);
}

/**
 * Step 3 of an upload: verify the object exists with the declared size
 * (HeadObject for R2) and only then create the File row.
 *
 * Storage keys are single-use: the UploadKey row is inserted in the same
 * transaction as the File row and is NOT removed when the file is deleted.
 * - Completing again while the File exists returns that File (idempotent retry).
 * - Completing a key whose File was deleted (token replay) is CONFLICT.
 * - Concurrent completes: the UploadKey primary key lets exactly one insert
 *   win; the loser returns the winner's File.
 *
 * Orphan objects (bytes in storage with no File row) can still arise and are
 * not cleaned up here: an upload PUT that is never completed (tab closed,
 * network loss, token expired before complete), a completion that fails after
 * the PUT (folder deleted, size mismatch on a failed best-effort delete), a
 * storage delete that fails after a File/Folder delete (logged by
 * deleteObjects), and on R2 a presigned PUT replayed after a delete and then
 * never completed (the URL stays valid until UPLOAD_TOKEN_TTL_MS). A periodic
 * sweep comparing storage listings against File.storageKey would collect them.
 */
export async function completeUpload(
  ctx: TenantContext,
  token: unknown,
  storage: StorageDriver = getStorage(),
) {
  const p = readToken(ctx, token);

  const existing = await db.file.findUnique({ where: { storageKey: p.k } });
  if (existing) {
    if (existing.workspaceId !== ctx.workspaceId) throw notFound("Dosya bulunamadı.");
    // A trashed file's key stays taken: a replayed token must not resurrect it.
    if (existing.deletedAt) throw new ServiceError("CONFLICT", KEY_USED_MESSAGE);
    return existing;
  }
  const used = await db.uploadKey.findUnique({ where: { storageKey: p.k }, select: { storageKey: true } });
  if (used) await rejectConsumedKey(storage, ctx, p.k);

  const head = await storage.head(p.k);
  if (!head) {
    throw new ServiceError("VALIDATION", "Dosya yüklenemedi. Lütfen tekrar deneyin.");
  }
  if (head.size > MAX_FILE_SIZE || head.size !== p.s) {
    await deleteObjects(storage, [p.k]);
    throw new ServiceError("VALIDATION", "Yüklenen dosyanın boyutu beklenenle eşleşmiyor.");
  }

  try {
    const file = await db.$transaction(async (tx) => {
      await lockTree(tx, ctx.workspaceId);
      if (p.f) {
        const folder = await tx.folder.findFirst({
          where: { id: p.f, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true },
        });
        if (!folder) throw notFound("Hedef klasör artık mevcut değil.");
      }
      // Consume the key first: a concurrent or replayed complete fails here (P2002).
      await tx.uploadKey.create({ data: { storageKey: p.k, workspaceId: ctx.workspaceId } });
      return tx.file.create({
        data: {
          workspaceId: ctx.workspaceId,
          folderId: p.f,
          uploadedById: ctx.userId,
          name: p.n,
          mimeType: p.t,
          size: head.size,
          storageKey: p.k,
          fromChat: p.c === true,
        },
      });
    });
    // Only a fresh completion records (retries return above); never throws.
    // Chat photos are not "files uploaded": the chat message is their only home.
    if (!file.fromChat) {
      await recordActivity(ctx, {
        type: "FILE_UPLOADED",
        title: file.name,
        path: folderActivityPath(file.folderId),
        subject: { type: "file", id: file.id },
      });
    }
    return file;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const row = await db.file.findUnique({ where: { storageKey: p.k } });
      if (row && row.workspaceId === ctx.workspaceId && !row.deletedAt) return row;
      if (!row) {
        // Key consumed by a completion whose File is already gone again.
        const used = await db.uploadKey.findUnique({ where: { storageKey: p.k }, select: { storageKey: true } });
        if (used) await rejectConsumedKey(storage, ctx, p.k);
      }
      throw new ServiceError("CONFLICT", KEY_USED_MESSAGE);
    }
    if (e instanceof ServiceError && e.code === "NOT_FOUND") await deleteObjects(storage, [p.k]);
    throw e;
  }
}

export type LocalUploadResult =
  | { ok: true; size: number }
  | { ok: false; status: 400 | 403 | 409 | 413; error: string };

/**
 * Local-driver upload target (PUT /api/files/upload?token=...). Trusts only the
 * signed token, re-checks that `userId` is the uploader and still a member,
 * refuses to overwrite and enforces the declared size.
 */
export async function acceptLocalUpload(
  userId: string,
  token: unknown,
  body: ReadableStream<Uint8Array> | Uint8Array | null,
  contentLength: number | null,
  storage: StorageDriver = getStorage(),
): Promise<LocalUploadResult> {
  if (storage.name !== "local") return { ok: false, status: 400, error: "Bu yükleme yolu kapalı." };
  const p = verifyUploadToken(token);
  if (!p || p.u !== userId || !keyBelongsToWorkspace(p.k, p.w)) {
    return { ok: false, status: 403, error: "Yükleme oturumu geçersiz veya süresi dolmuş." };
  }
  const member = await db.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: p.w } },
    select: { id: true },
  });
  if (!member) return { ok: false, status: 403, error: "Yükleme oturumu geçersiz veya süresi dolmuş." };
  if (!body) {
    if (p.s !== 0) return { ok: false, status: 400, error: "Dosya içeriği boş." };
    body = new Uint8Array(0);
  }
  if (contentLength !== null && contentLength !== p.s) {
    return { ok: false, status: contentLength > p.s ? 413 : 400, error: "Dosya boyutu beklenenle eşleşmiyor." };
  }
  // A consumed key (UploadKey row) stays taken after its file is deleted, so a
  // replayed token cannot put the bytes back.
  const taken =
    (await db.uploadKey.findUnique({ where: { storageKey: p.k }, select: { storageKey: true } })) !== null ||
    (await storage.head(p.k)) !== null ||
    (await db.file.findUnique({ where: { storageKey: p.k }, select: { id: true } })) !== null;
  if (taken) return { ok: false, status: 409, error: "Bu yükleme zaten tamamlandı." };

  try {
    const { size } = await storage.put(p.k, body, {
      contentType: p.t,
      maxBytes: Math.min(p.s, MAX_FILE_SIZE),
    });
    if (size !== p.s) {
      await deleteObjects(storage, [p.k]);
      return { ok: false, status: 400, error: "Dosya boyutu beklenenle eşleşmiyor." };
    }
    return { ok: true, size };
  } catch (e) {
    if (e instanceof StorageLimitError) {
      return { ok: false, status: 413, error: "Dosya en fazla 25 MB olabilir." };
    }
    if (e instanceof StorageExistsError) {
      return { ok: false, status: 409, error: "Bu yükleme zaten tamamlandı." };
    }
    throw e;
  }
}

export async function renameFile(ctx: TenantContext, input: unknown) {
  const data = parseInput(renameSchema(fileNameSchema), input);
  const file = await findFile(db, ctx, data.id);
  if (!canModify(ctx, file.uploadedById)) throw forbidden();
  return db.file.update({ where: { id: file.id }, data: { name: data.name } });
}

async function assertTargetFolder(tx: Tx, ctx: TenantContext, targetFolderId: string | null) {
  if (targetFolderId) await findFolder(tx, ctx, targetFolderId);
}

export async function moveFile(ctx: TenantContext, input: unknown) {
  const data = parseInput(moveSchema, input);
  return db.$transaction(async (tx) => {
    await lockTree(tx, ctx.workspaceId);
    const file = await findFile(tx, ctx, data.id);
    if (!canModify(ctx, file.uploadedById)) throw forbidden();
    await assertTargetFolder(tx, ctx, data.targetFolderId);
    return tx.file.update({ where: { id: file.id }, data: { folderId: data.targetFolderId } });
  });
}

/** Moves the file to the trash (soft delete); the stored object stays until the trash is purged. */
export async function deleteFile(
  ctx: TenantContext,
  fileId: string,
  // Kept so callers can still pass a driver: objects are only removed when the trash is purged.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _storage?: StorageDriver,
) {
  const id = parseInput(idSchema, fileId);
  const file = await findFile(db, ctx, id);
  if (!canModify(ctx, file.uploadedById)) throw forbidden();
  const count = await db.$transaction(async (tx) => {
    await forgetActivity(ctx, [{ type: "file", id: file.id }], tx);
    return (
      await tx.file.updateMany({
        where: { id: file.id, workspaceId: ctx.workspaceId, deletedAt: null },
        data: { deletedAt: new Date(), deletedById: ctx.userId },
      })
    ).count;
  });
  if (count === 0) throw notFound("Dosya bulunamadı.");
  return { folderId: file.folderId };
}

/**
 * Hard-delete a file: remove the row and its stored bytes immediately,
 * bypassing the trash. For ephemeral attachments (e.g. chat photos) that are
 * not part of the Files section's soft-delete/restore model, so they must not
 * linger in the trash after their message is gone.
 */
export async function hardDeleteFile(ctx: TenantContext, fileId: string, storage?: StorageDriver) {
  const id = parseInput(idSchema, fileId);
  const file = await findFile(db, ctx, id);
  if (!canModify(ctx, file.uploadedById)) throw forbidden();
  await db.$transaction(async (tx) => {
    await forgetActivity(ctx, [{ type: "file", id: file.id }], tx);
    await tx.file.deleteMany({ where: { id: file.id, workspaceId: ctx.workspaceId } });
  });
  if (storage && keyBelongsToWorkspace(file.storageKey, ctx.workspaceId)) {
    await deleteObjects(storage, [file.storageKey]);
  }
  return { folderId: file.folderId };
}

/**
 * Resolve a TenantContext for a download by file id: null when the file does
 * not exist or `userId` is not a member of its workspace (callers answer 404
 * in both cases so existence is never revealed).
 */
export async function authorizeFileAccess(userId: string, fileId: string): Promise<TenantContext | null> {
  const id = idSchema.safeParse(fileId);
  if (!id.success || !userId) return null;
  const file = await db.file.findUnique({ where: { id: id.data }, select: { workspaceId: true, deletedAt: true } });
  if (!file || file.deletedAt) return null;
  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: file.workspaceId } },
    select: { role: true },
  });
  if (!membership) return null;
  return { userId, workspaceId: file.workspaceId, role: membership.role };
}

/** File row + download handle (stream for local, presigned URL for R2). */
export async function getFileDownload(
  ctx: TenantContext,
  fileId: string,
  storage: StorageDriver = getStorage(),
) {
  const id = parseInput(idSchema, fileId);
  const file = await findFile(db, ctx, id);
  if (!keyBelongsToWorkspace(file.storageKey, ctx.workspaceId)) throw notFound("Dosya bulunamadı.");
  const download = await storage.getDownload(file.storageKey, {
    fileName: file.name,
    contentType: file.mimeType,
  });
  if (!download) throw notFound("Dosya içeriği bulunamadı.");
  return { file, download };
}

// ----------------------------------------------------------- previews ----

export const NOT_INLINE_MESSAGE = "Bu dosya tarayıcıda önizlenemez.";

type StoredFile = { mimeType: string; storageKey: string };

/**
 * The allow-listed inline rule for a file, but only when its stored bytes
 * start with that type's magic number. "missing" when the object is gone.
 * The declared MIME type alone (client-supplied) is never enough.
 */
async function verifiedInlineSpec(storage: StorageDriver, file: StoredFile) {
  const spec = inlineSpec(file.mimeType);
  if (!spec) return null;
  const head = await storage.readBytes(file.storageKey, SNIFF_BYTES);
  if (!head) return "missing" as const;
  return sniffMatches(file.mimeType, head) ? spec : null;
}

export type FileInline =
  | { kind: "redirect"; url: string }
  | {
      kind: "body";
      status: 200 | 206;
      body: ReadableStream<Uint8Array>;
      headers: Record<string, string>;
    }
  | { kind: "unsatisfiable"; size: number };

/**
 * Inline body for GET /api/files/[fileId]/inline. Only allow-listed images,
 * PDF, audio and video whose leading bytes match the type are served; any
 * other file (including text, SVG and HTML) is VALIDATION (NOT_INLINE_MESSAGE).
 * Local: the response headers (canonical type, nosniff, sandboxed CSP, CORP,
 * inline disposition, private cache) plus single-range 206 / 416 for media.
 * R2: a presigned GET with inline disposition and the canonical type.
 */
export async function getFileInline(
  ctx: TenantContext,
  fileId: string,
  opts: { range?: string | null } = {},
  storage: StorageDriver = getStorage(),
): Promise<FileInline> {
  const id = parseInput(idSchema, fileId);
  const file = await findFile(db, ctx, id);
  if (!keyBelongsToWorkspace(file.storageKey, ctx.workspaceId)) throw notFound("Dosya bulunamadı.");
  const spec = await verifiedInlineSpec(storage, file);
  if (spec === "missing") throw notFound("Dosya içeriği bulunamadı.");
  if (!spec) throw new ServiceError("VALIDATION", NOT_INLINE_MESSAGE);

  const base = { fileName: file.name, contentType: spec.contentType, disposition: "inline" as const };
  if (storage.name === "r2") {
    const d = await storage.getDownload(file.storageKey, base);
    if (!d || d.kind !== "redirect") throw notFound("Dosya içeriği bulunamadı.");
    return { kind: "redirect", url: d.url };
  }

  const stat = await storage.head(file.storageKey);
  if (!stat) throw notFound("Dosya içeriği bulunamadı.");
  const ranged = spec.kind === "audio" || spec.kind === "video";
  const parsed = ranged ? parseRange(opts.range, stat.size) : ({ kind: "none" } as const);
  if (parsed.kind === "unsatisfiable") return { kind: "unsatisfiable", size: stat.size };
  const range = parsed.kind === "range" ? { start: parsed.start, end: parsed.end } : undefined;

  const d = await storage.getDownload(file.storageKey, { ...base, range });
  if (!d) throw notFound("Dosya içeriği bulunamadı.");
  if (d.kind === "redirect") return { kind: "redirect", url: d.url };

  const headers = inlineHeaders(spec.kind, spec.contentType, file.name);
  if (range) {
    return {
      kind: "body",
      status: 206,
      body: d.stream,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${d.size}`,
        "Content-Length": String(range.end - range.start + 1),
      },
    };
  }
  return { kind: "body", status: 200, body: d.stream, headers: { ...headers, "Content-Length": String(d.size) } };
}

export type FilePreview =
  | { kind: InlineKind }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "none" };

/**
 * File row (with uploader and folder breadcrumbs) and what the preview page
 * may show: an inline kind (verified by magic number, served by the inline
 * endpoint), a capped text excerpt read here and rendered as escaped text,
 * or nothing. NOT_FOUND outside ctx.workspaceId.
 */
export async function getFilePreview(
  ctx: TenantContext,
  fileId: string,
  storage: StorageDriver = getStorage(),
) {
  const id = parseInput(idSchema, fileId);
  const file = await db.file.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
    include: { uploadedBy: userSelect },
  });
  if (!file) throw notFound("Dosya bulunamadı.");
  const breadcrumbs = file.folderId
    ? (await ancestorChain(db, ctx, file.folderId)).map(({ id, name }) => ({ id, name }))
    : [];

  let preview: FilePreview = { kind: "none" };
  if (keyBelongsToWorkspace(file.storageKey, ctx.workspaceId)) {
    if (inlineSpec(file.mimeType)) {
      const spec = await verifiedInlineSpec(storage, file);
      if (spec && spec !== "missing") preview = { kind: spec.kind };
    } else if (isTextPreviewable(file.mimeType, file.name)) {
      const bytes = await storage.readBytes(file.storageKey, TEXT_PREVIEW_MAX_BYTES);
      const decoded = bytes ? decodeTextPreview(bytes, file.size) : null;
      if (decoded) preview = { kind: "text", ...decoded };
    }
  }
  return { file, breadcrumbs, preview };
}

// ---------------------------------------------------------- documents ----

async function findDocument(client: Tx | typeof db, ctx: TenantContext, id: string) {
  const doc = await client.document.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null } });
  if (!doc) throw notFound("Doküman bulunamadı.");
  return doc;
}

/** Document with author and breadcrumbs of its folder. */
export async function getDocument(ctx: TenantContext, documentId: string) {
  const id = parseInput(idSchema, documentId);
  const doc = await db.document.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
    include: { author: userSelect },
  });
  if (!doc) throw notFound("Doküman bulunamadı.");
  const breadcrumbs = doc.folderId
    ? (await ancestorChain(db, ctx, doc.folderId)).map(({ id, name }) => ({ id, name }))
    : [];
  return { document: doc, breadcrumbs };
}

export async function createDocument(ctx: TenantContext, input: unknown) {
  const data = parseInput(documentSchema, input);
  const doc = await db.$transaction(async (tx) => {
    await lockTree(tx, ctx.workspaceId);
    await assertTargetFolder(tx, ctx, data.folderId);
    return tx.document.create({
      data: {
        workspaceId: ctx.workspaceId,
        folderId: data.folderId,
        authorId: ctx.userId,
        title: data.title,
        content: data.content,
      },
    });
  });
  await recordActivity(ctx, {
    type: "DOCUMENT_CREATED",
    title: doc.title,
    path: documentActivityPath(doc.id),
    subject: { type: "document", id: doc.id },
  }); // after commit
  return doc;
}

export async function updateDocument(ctx: TenantContext, input: unknown) {
  const data = parseInput(updateDocumentSchema, input);
  const doc = await findDocument(db, ctx, data.id);
  if (!canModify(ctx, doc.authorId)) throw forbidden();
  const updated = await db.document.update({
    where: { id: doc.id },
    data: { title: data.title, content: data.content },
  });
  await recordActivity(ctx, {
    type: "DOCUMENT_UPDATED",
    title: updated.title,
    path: documentActivityPath(updated.id),
    subject: { type: "document", id: updated.id },
  });
  return updated;
}

export async function moveDocument(ctx: TenantContext, input: unknown) {
  const data = parseInput(moveSchema, input);
  return db.$transaction(async (tx) => {
    await lockTree(tx, ctx.workspaceId);
    const doc = await findDocument(tx, ctx, data.id);
    if (!canModify(ctx, doc.authorId)) throw forbidden();
    await assertTargetFolder(tx, ctx, data.targetFolderId);
    return tx.document.update({ where: { id: doc.id }, data: { folderId: data.targetFolderId } });
  });
}

/** Moves the document to the trash (soft delete). */
export async function deleteDocument(ctx: TenantContext, documentId: string) {
  const id = parseInput(idSchema, documentId);
  const doc = await findDocument(db, ctx, id);
  if (!canModify(ctx, doc.authorId)) throw forbidden();
  await db.$transaction(async (tx) => {
    await forgetActivity(ctx, [{ type: "document", id: doc.id }], tx);
    const { count } = await tx.document.updateMany({
      where: { id: doc.id, workspaceId: ctx.workspaceId, deletedAt: null },
      data: { deletedAt: new Date(), deletedById: ctx.userId, updatedAt: doc.updatedAt },
    });
    if (count === 0) throw notFound("Doküman bulunamadı.");
  });
  return { folderId: doc.folderId };
}
