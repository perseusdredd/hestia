import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { canModify, hasRole } from "@/lib/roles";
import { getStorage, keyBelongsToWorkspace, type StorageDriver } from "@/lib/storage";
import type { TenantContext } from "@/lib/tenant-context";
import {
  documentActivityPath,
  eventActivityPath,
  folderActivityPath,
  postActivityPath,
  recordActivity,
  type ActivitySubject,
} from "@/server/activity";
import { deleteObjects, restoreFolderTree } from "@/server/files";
import { forbidden, notFound, parseInput, ServiceError } from "@/server/errors";
import { visiblePostWhere } from "@/server/post-visibility";

/*
 * Trash (soft delete). Posts, to-dos, to-do lists, events, files, documents and
 * folders are not removed when deleted: they get deletedAt / deletedById and
 * disappear from every list, search and detail query (each of those filters on
 * deletedAt: null). A list or folder takes the rows inside it along with the
 * SAME deletedAt, so restoring it brings back exactly that set. The trash page
 * only shows the roots: rows whose list / folder is still live.
 *
 * Who may see and restore: the author (or creator / uploader) and ADMIN+.
 * Rows are purged for good after TRASH_RETENTION_DAYS by the daily cleanup
 * (purgeExpiredTrash, a system task without ctx), or by hand (purgeTrashItem).
 */

export const TRASH_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows listed per kind on the trash page. */
export const TRASH_LIST_MAX = 100;
/** Files purged per cleanup run (their stored objects are deleted one by one). */
const PURGE_FILES_PER_RUN = 500;

export const TRASH_KINDS = ["post", "todoItem", "todoList", "event", "file", "document", "folder"] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];

export const TRASH_KIND_LABELS: Record<TrashKind, string> = {
  post: "Mesaj",
  todoItem: "Görev",
  todoList: "Yapılacaklar listesi",
  event: "Etkinlik",
  file: "Dosya",
  document: "Doküman",
  folder: "Klasör",
};

const refSchema = z.object({
  kind: z.enum(TRASH_KINDS, { error: "Geçersiz öğe türü." }),
  id: z.string().trim().min(1, "Geçersiz kayıt.").max(64, "Geçersiz kayıt."),
});

export type TrashItemDTO = {
  kind: TrashKind;
  id: string;
  title: string;
  /** Where it lived (list or folder name), when it had one. */
  detail: string | null;
  deletedAt: Date;
  /** When it is purged for good. */
  purgeAt: Date;
  deletedBy: { name: string | null; email: string } | null;
};

export function purgeDate(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS);
}

// ------------------------------------------------------------- listing ----

/**
 * Trashed roots of the workspace, newest deletion first. Members see only what
 * they own; ADMIN+ see everything.
 */
export async function listTrash(ctx: TenantContext): Promise<TrashItemDTO[]> {
  const base = { workspaceId: ctx.workspaceId, deletedAt: { not: null } } as const;
  const admin = hasRole(ctx.role, "ADMIN");
  const mine = <K extends string>(key: K) => (admin ? {} : ({ [key]: ctx.userId } as Record<K, string>));
  const take = TRASH_LIST_MAX;
  const order = { deletedAt: "desc" } as const;

  const [posts, items, lists, events, files, documents, folders] = await Promise.all([
    db.post.findMany({
      where: { ...base, ...mine("authorId"), ...visiblePostWhere(ctx) },
      orderBy: order,
      take,
      select: { id: true, title: true, deletedAt: true, deletedById: true },
    }),
    db.todoItem.findMany({
      where: { ...base, ...mine("createdById"), list: { deletedAt: null } },
      orderBy: order,
      take,
      select: { id: true, title: true, deletedAt: true, deletedById: true, list: { select: { name: true } } },
    }),
    db.todoList.findMany({
      where: { ...base, ...mine("createdById") },
      orderBy: order,
      take,
      select: { id: true, name: true, deletedAt: true, deletedById: true },
    }),
    db.event.findMany({
      where: { ...base, ...mine("createdById") },
      orderBy: order,
      take,
      select: { id: true, title: true, deletedAt: true, deletedById: true },
    }),
    db.file.findMany({
      where: { ...base, ...mine("uploadedById"), OR: [{ folderId: null }, { folder: { deletedAt: null } }] },
      orderBy: order,
      take,
      select: { id: true, name: true, deletedAt: true, deletedById: true, folder: { select: { name: true } } },
    }),
    db.document.findMany({
      where: { ...base, ...mine("authorId"), OR: [{ folderId: null }, { folder: { deletedAt: null } }] },
      orderBy: order,
      take,
      select: { id: true, title: true, deletedAt: true, deletedById: true, folder: { select: { name: true } } },
    }),
    db.folder.findMany({
      where: { ...base, ...mine("createdById"), OR: [{ parentId: null }, { parent: { deletedAt: null } }] },
      orderBy: order,
      take,
      select: { id: true, name: true, deletedAt: true, deletedById: true, parent: { select: { name: true } } },
    }),
  ]);

  type Row = { id: string; deletedAt: Date | null; deletedById: string | null };
  const dto = (kind: TrashKind, row: Row, title: string, detail: string | null) => ({
    kind,
    id: row.id,
    title,
    detail,
    deletedAt: row.deletedAt as Date,
    deletedById: row.deletedById,
  });
  const all = [
    ...posts.map((r) => dto("post", r, r.title, null)),
    ...items.map((r) => dto("todoItem", r, r.title, r.list.name)),
    ...lists.map((r) => dto("todoList", r, r.name, null)),
    ...events.map((r) => dto("event", r, r.title, null)),
    ...files.map((r) => dto("file", r, r.name, r.folder?.name ?? null)),
    ...documents.map((r) => dto("document", r, r.title, r.folder?.name ?? null)),
    ...folders.map((r) => dto("folder", r, r.name, r.parent?.name ?? null)),
  ].sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());

  const userIds = [...new Set(all.map((i) => i.deletedById).filter((id): id is string => Boolean(id)))];
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  return all.map(({ deletedById, ...item }) => {
    const u = deletedById ? byId.get(deletedById) : undefined;
    return { ...item, purgeAt: purgeDate(item.deletedAt), deletedBy: u ? { name: u.name, email: u.email } : null };
  });
}

// ------------------------------------------------------------ restoring ----

type Found = {
  title: string;
  ownerId: string;
  deletedAt: Date;
  path: string;
  subject: ActivitySubject;
  /** True only for an unpublished post (draft): restoring it must not announce its title. */
  isDraft: boolean;
};

const gone = "Öğe çöp kutusunda bulunamadı.";
const trashed = { not: null } as const;

/** Loads the trashed row (scoped by workspace); NOT_FOUND when it is not in the trash. */
async function findTrashed(ctx: TenantContext, kind: TrashKind, id: string): Promise<Found> {
  const where = { id, workspaceId: ctx.workspaceId, deletedAt: trashed };
  switch (kind) {
    case "post": {
      // A draft is author-only even in the trash: a non-author (incl. ADMIN) must
      // not find, restore or purge it, nor see its title announced.
      const r = await db.post.findFirst({ where: { ...where, ...visiblePostWhere(ctx) } });
      if (!r?.deletedAt) break;
      return { title: r.title, ownerId: r.authorId, deletedAt: r.deletedAt, path: postActivityPath(r.id), subject: { type: "post", id: r.id }, isDraft: r.publishedAt === null };
    }
    case "todoItem": {
      const r = await db.todoItem.findFirst({ where });
      if (!r?.deletedAt) break;
      return { title: r.title, ownerId: r.createdById, deletedAt: r.deletedAt, path: `todos/${r.id}`, subject: { type: "todoItem", id: r.id }, isDraft: false };
    }
    case "todoList": {
      const r = await db.todoList.findFirst({ where });
      if (!r?.deletedAt) break;
      return { title: r.name, ownerId: r.createdById, deletedAt: r.deletedAt, path: "todos", subject: { type: "todoList", id: r.id }, isDraft: false };
    }
    case "event": {
      const r = await db.event.findFirst({ where });
      if (!r?.deletedAt) break;
      return { title: r.title, ownerId: r.createdById, deletedAt: r.deletedAt, path: eventActivityPath(r), subject: { type: "event", id: r.id }, isDraft: false };
    }
    case "file": {
      const r = await db.file.findFirst({ where });
      if (!r?.deletedAt) break;
      return { title: r.name, ownerId: r.uploadedById, deletedAt: r.deletedAt, path: folderActivityPath(r.folderId), subject: { type: "file", id: r.id }, isDraft: false };
    }
    case "document": {
      const r = await db.document.findFirst({ where });
      if (!r?.deletedAt) break;
      return { title: r.title, ownerId: r.authorId, deletedAt: r.deletedAt, path: documentActivityPath(r.id), subject: { type: "document", id: r.id }, isDraft: false };
    }
    case "folder": {
      const r = await db.folder.findFirst({ where });
      if (!r?.deletedAt) break;
      return { title: r.name, ownerId: r.createdById, deletedAt: r.deletedAt, path: folderActivityPath(r.id), subject: { type: "folder", id: r.id }, isDraft: false };
    }
  }
  throw notFound(gone);
}

const parentDeleted = (what: string) =>
  new ServiceError("CONFLICT", `${what} silinmiş. Önce onu geri yükleyin.`);

/**
 * Takes the item out of the trash and records an ITEM_RESTORED feed row.
 * Author / creator / uploader or ADMIN+. A to-do whose list is trashed, or a
 * file / document / folder whose folder is trashed, cannot come back alone.
 */
export async function restoreTrashItem(ctx: TenantContext, input: unknown): Promise<{ title: string }> {
  const { kind, id } = parseInput(refSchema, input);
  const found = await findTrashed(ctx, kind, id);
  if (!canModify(ctx, found.ownerId)) throw forbidden("Bu öğeyi geri yükleme yetkiniz yok.");

  const clear = { deletedAt: null, deletedById: null };
  const scope = { id, workspaceId: ctx.workspaceId, deletedAt: trashed };
  let restored: { count: number } | null = null;
  switch (kind) {
    case "post": {
      const row = await db.post.findFirstOrThrow({ where: scope, select: { updatedAt: true } });
      restored = await db.post.updateMany({ where: scope, data: { ...clear, updatedAt: row.updatedAt } });
      break;
    }
    case "todoItem": {
      const row = await db.todoItem.findFirstOrThrow({ where: scope, select: { updatedAt: true, list: { select: { deletedAt: true } } } });
      if (row.list.deletedAt) throw parentDeleted("Görevin listesi");
      restored = await db.todoItem.updateMany({ where: scope, data: { ...clear, updatedAt: row.updatedAt } });
      break;
    }
    case "todoList": {
      restored = await db.$transaction(async (tx) => {
        const list = await tx.todoList.findFirstOrThrow({ where: scope, select: { updatedAt: true, deletedAt: true } });
        const res = await tx.todoList.updateMany({ where: scope, data: { ...clear, updatedAt: list.updatedAt } });
        // Only the items that went to the trash together with the list.
        await tx.todoItem.updateMany({
          where: { listId: id, workspaceId: ctx.workspaceId, deletedAt: list.deletedAt },
          data: clear,
        });
        return res;
      });
      break;
    }
    case "event": {
      const row = await db.event.findFirstOrThrow({ where: scope, select: { updatedAt: true } });
      restored = await db.event.updateMany({ where: scope, data: { ...clear, updatedAt: row.updatedAt } });
      break;
    }
    case "file": {
      const row = await db.file.findFirstOrThrow({ where: scope, select: { folder: { select: { deletedAt: true } } } });
      if (row.folder?.deletedAt) throw parentDeleted("Dosyanın klasörü");
      restored = await db.file.updateMany({ where: scope, data: clear });
      break;
    }
    case "document": {
      const row = await db.document.findFirstOrThrow({ where: scope, select: { updatedAt: true, folder: { select: { deletedAt: true } } } });
      if (row.folder?.deletedAt) throw parentDeleted("Dokümanın klasörü");
      restored = await db.document.updateMany({ where: scope, data: { ...clear, updatedAt: row.updatedAt } });
      break;
    }
    case "folder": {
      await restoreFolderTree(ctx, id);
      restored = { count: 1 };
      break;
    }
  }
  if (!restored || restored.count === 0) throw notFound(gone);

  // Restoring an unpublished draft must not broadcast its title to the workspace.
  if (!found.isDraft) {
    await recordActivity(ctx, { type: "ITEM_RESTORED", title: found.title, path: found.path, subject: found.subject });
  }
  return { title: found.title };
}

// ------------------------------------------------------------- purging ----

/** Hard-deletes trashed files matching `where`, then their stored objects. */
async function purgeFiles(
  where: Prisma.FileWhereInput,
  storage: StorageDriver | undefined,
  take?: number,
): Promise<number> {
  const rows = await db.file.findMany({
    where: { ...where, deletedAt: trashed },
    select: { id: true, storageKey: true, workspaceId: true },
    ...(take ? { take } : {}),
  });
  if (rows.length === 0) return 0;
  const res = await db.file.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, deletedAt: trashed } });
  // After the commit; UploadKey rows stay, so a replayed upload token cannot bring the file back.
  await deleteObjects(
    storage ?? getStorage(),
    rows.filter((r) => keyBelongsToWorkspace(r.storageKey, r.workspaceId)).map((r) => r.storageKey),
  );
  return res.count;
}

/** Deletes one trashed item (and what went with it) for good. Same permission as restoring. */
export async function purgeTrashItem(
  ctx: TenantContext,
  input: unknown,
  storage?: StorageDriver,
): Promise<{ title: string }> {
  const { kind, id } = parseInput(refSchema, input);
  const found = await findTrashed(ctx, kind, id);
  if (!canModify(ctx, found.ownerId)) throw forbidden("Bu öğeyi kalıcı olarak silme yetkiniz yok.");
  const scope = { id, workspaceId: ctx.workspaceId, deletedAt: trashed };
  const together = { workspaceId: ctx.workspaceId, deletedAt: found.deletedAt };

  switch (kind) {
    case "post":
      await db.post.deleteMany({ where: scope }); // comments cascade
      break;
    case "todoItem":
      await db.todoItem.deleteMany({ where: scope });
      break;
    case "todoList":
      await db.todoList.deleteMany({ where: scope }); // items cascade
      break;
    case "event":
      await db.event.deleteMany({ where: scope });
      break;
    case "document":
      await db.document.deleteMany({ where: scope });
      break;
    case "file":
      await purgeFiles({ id, workspaceId: ctx.workspaceId }, storage);
      break;
    case "folder":
      // Everything that was trashed with it, files first (their folder link is SetNull).
      await purgeFiles(together, storage);
      await db.document.deleteMany({ where: { ...together, deletedAt: found.deletedAt } });
      await db.folder.deleteMany({ where: scope }); // subfolders cascade
      break;
  }
  return { title: found.title };
}

export type TrashPurgeResult = {
  posts: number;
  todoItems: number;
  todoLists: number;
  events: number;
  files: number;
  documents: number;
  folders: number;
};

/**
 * Daily cleanup: removes everything trashed more than TRASH_RETENTION_DAYS
 * before `now`, in every workspace. System task without a ctx (see
 * housekeeping.ts). Children go before parents so nothing is orphaned: items
 * before lists, files and documents before folders.
 */
export async function purgeExpiredTrash(
  now: Date = new Date(),
  storage?: StorageDriver,
): Promise<TrashPurgeResult> {
  const expired = { lt: new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS) };
  const where = { deletedAt: expired };
  const posts = await db.post.deleteMany({ where });
  const todoItems = await db.todoItem.deleteMany({ where });
  const todoLists = await db.todoList.deleteMany({ where });
  const events = await db.event.deleteMany({ where });
  const files = await purgeFiles(where, storage, PURGE_FILES_PER_RUN);
  const documents = await db.document.deleteMany({ where });
  const folders = await db.folder.deleteMany({ where });
  return {
    posts: posts.count,
    todoItems: todoItems.count,
    todoLists: todoLists.count,
    events: events.count,
    files,
    documents: documents.count,
    folders: folders.count,
  };
}
