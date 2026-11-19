import type { Prisma, Project } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { canModify, clientVisibleWhere, hasRole } from "@/lib/roles";
import { slugify } from "@/lib/slug";
import type { TenantContext } from "@/lib/tenant-context";
import { forbidden, notFound, parseInput, ServiceError } from "@/server/errors";
import { visiblePostWhere } from "@/server/post-visibility";

/**
 * Projects (Basecamp-style buckets) inside a workspace. ADDITIVE: content
 * with projectId = null belongs to "Genel" (the workspace level), which is how
 * every pre-existing row behaves. Workspace-wide listings elsewhere are NOT
 * filtered by project; only the per-project views below filter by projectId.
 * Every function is scoped by ctx.workspaceId. Creating, renaming and
 * archiving needs ADMIN or OWNER.
 */

const MAX_PROJECTS = 200;
const OVERVIEW_TAKE = 20;

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

const nameSchema = z
  .string({ error: "Proje adı gerekli." })
  .trim()
  .min(1, "Proje adı gerekli.")
  .max(80, "Proje adı en fazla 80 karakter olabilir.");
const descriptionSchema = z.preprocess(
  emptyToNull,
  z.string().trim().max(2000, "Açıklama en fazla 2000 karakter olabilir.").nullable(),
);
const idSchema = z.string().trim().min(1, "Geçersiz kayıt.").max(64, "Geçersiz kayıt.");
const slugParamSchema = z.string().trim().min(1).max(100);

const createSchema = z.object({ name: nameSchema, description: descriptionSchema.optional() });
const renameSchema = z.object({ name: nameSchema.optional(), description: descriptionSchema.optional() });

export type ProjectDTO = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  archived: boolean;
  position: number;
  createdAt: Date;
};

function toDTO(p: Project): ProjectDTO {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    archived: p.archived,
    position: p.position,
    createdAt: p.createdAt,
  };
}

function requireAdmin(ctx: TenantContext) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden("Projeleri yalnızca yöneticiler yönetebilir.");
}

/** Serialise slug/position allocation per workspace (released at COMMIT). */
export async function lockProjects(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`projects:${workspaceId}`}))`;
}

/**
 * Inserts a project (slug + position allocated) inside the caller's transaction.
 * Caller must already hold lockProjects. Templates share the slug namespace but
 * are not counted against the project cap and do not take a list position.
 */
export async function insertProjectTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  data: { name: string; description: string | null; isTemplate?: boolean; templateSpec?: Prisma.InputJsonValue },
): Promise<Project> {
  const isTemplate = data.isTemplate ?? false;
  const base = slugify(data.name) || (isTemplate ? "sablon" : "proje");
  if (!isTemplate) {
    const count = await tx.project.count({ where: { workspaceId: ctx.workspaceId, isTemplate: false } });
    if (count >= MAX_PROJECTS) {
      throw new ServiceError("VALIDATION", `Bir alanda en fazla ${MAX_PROJECTS} proje olabilir.`);
    }
  }
  const taken = new Set(
    (
      await tx.project.findMany({
        where: { workspaceId: ctx.workspaceId, slug: { startsWith: base } },
        select: { slug: true },
      })
    ).map((p) => p.slug),
  );
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  const max = await tx.project.aggregate({
    where: { workspaceId: ctx.workspaceId, isTemplate: false },
    _max: { position: true },
  });
  return tx.project.create({
    data: {
      workspaceId: ctx.workspaceId,
      createdById: ctx.userId,
      name: data.name,
      slug,
      description: data.description,
      position: isTemplate ? 0 : (max._max.position ?? -1) + 1,
      isTemplate,
      ...(data.templateSpec !== undefined ? { templateSpec: data.templateSpec } : {}),
    },
  });
}

export async function createProject(ctx: TenantContext, input: unknown): Promise<ProjectDTO> {
  requireAdmin(ctx);
  const data = parseInput(createSchema, input);
  const project = await db.$transaction(async (tx) => {
    await lockProjects(tx, ctx.workspaceId);
    return insertProjectTx(tx, ctx, { name: data.name, description: data.description ?? null });
  });
  return toDTO(project);
}

async function findProjectById(ctx: TenantContext, id: string) {
  const project = await db.project.findFirst({
    where: { id: parseInput(idSchema, id), workspaceId: ctx.workspaceId, isTemplate: false },
  });
  if (!project) throw notFound("Proje bulunamadı.");
  return project;
}

/** Rename (and/or re-describe) a project. The slug never changes, so links stay valid. */
export async function renameProject(ctx: TenantContext, id: string, input: unknown): Promise<ProjectDTO> {
  requireAdmin(ctx);
  const data = parseInput(renameSchema, input);
  await findProjectById(ctx, id);
  const res = await db.project.updateMany({
    where: { id, workspaceId: ctx.workspaceId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
    },
  });
  if (res.count === 0) throw notFound("Proje bulunamadı.");
  return toDTO(await findProjectById(ctx, id));
}

/** Archive (default) or unarchive. Archived projects keep their content but accept no new items. */
export async function archiveProject(ctx: TenantContext, id: string, archived = true): Promise<ProjectDTO> {
  requireAdmin(ctx);
  await findProjectById(ctx, id);
  const res = await db.project.updateMany({ where: { id, workspaceId: ctx.workspaceId }, data: { archived } });
  if (res.count === 0) throw notFound("Proje bulunamadı.");
  return toDTO(await findProjectById(ctx, id));
}

/** Active projects first, archived ones separately (each in position order). */
export async function listProjects(ctx: TenantContext): Promise<{ active: ProjectDTO[]; archived: ProjectDTO[] }> {
  const rows = await db.project.findMany({
    where: { workspaceId: ctx.workspaceId, isTemplate: false },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return {
    active: rows.filter((p) => !p.archived).map(toDTO),
    archived: rows.filter((p) => p.archived).map(toDTO),
  };
}

/** Active projects only, for the "Proje" selects in create forms. */
export async function listProjectOptions(ctx: TenantContext): Promise<{ id: string; name: string }[]> {
  return db.project.findMany({
    where: { workspaceId: ctx.workspaceId, archived: false, isTemplate: false },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
}

export async function getProject(ctx: TenantContext, slug: string): Promise<ProjectDTO> {
  const project = await db.project.findFirst({
    where: { workspaceId: ctx.workspaceId, slug: parseInput(slugParamSchema, slug), isTemplate: false },
  });
  if (!project) throw notFound("Proje bulunamadı.");
  return toDTO(project);
}

/** Form value to id: empty string / null = "Genel" (null); undefined = not provided. */
export const projectIdField = z
  .string()
  .max(64)
  .nullish()
  .transform((v) => (v === undefined ? undefined : v || null));

/**
 * Validates a project choice for NEW content: null/undefined = "Genel"; otherwise
 * the project must exist in the workspace and not be archived.
 */
export async function assertAssignableProject(
  ctx: TenantContext,
  projectId: string | null | undefined,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<string | null> {
  if (!projectId) return null;
  const project = await client.project.findFirst({
    where: { id: projectId, workspaceId: ctx.workspaceId, isTemplate: false },
    select: { id: true, archived: true },
  });
  if (!project) {
    throw new ServiceError("VALIDATION", "Proje bulunamadı.", { projectId: ["Proje bulunamadı."] });
  }
  if (project.archived) {
    throw new ServiceError("VALIDATION", "Arşivlenmiş projeye yeni öğe eklenemez.", {
      projectId: ["Arşivlenmiş projeye yeni öğe eklenemez."],
    });
  }
  return project.id;
}

export type ProjectItemKind = "post" | "todoList" | "folder" | "event";

/**
 * Moves an existing item into a project (or back to "Genel" with null).
 * Same rule as editing the item itself: its author or an ADMIN/OWNER.
 * A subfolder cannot be assigned on its own (it follows its root folder);
 * assigning a root folder moves its whole subtree along.
 */
export async function setItemProject(
  ctx: TenantContext,
  kind: ProjectItemKind,
  itemId: string,
  projectId: string | null,
): Promise<void> {
  const id = parseInput(idSchema, itemId);
  const target = await assertAssignableProject(ctx, projectId);
  const base = { id, workspaceId: ctx.workspaceId, deletedAt: null };
  switch (kind) {
    case "post": {
      const row = await db.post.findFirst({ where: { ...base, ...visiblePostWhere(ctx) } });
      if (!row) throw notFound("Gönderi bulunamadı.");
      if (!canModify(ctx, row.authorId)) throw forbidden();
      await db.post.updateMany({ where: base, data: { projectId: target } });
      return;
    }
    case "todoList": {
      const row = await db.todoList.findFirst({ where: { ...base, ...clientVisibleWhere(ctx) } });
      if (!row) throw notFound("Liste bulunamadı.");
      if (!canModify(ctx, row.createdById)) throw forbidden();
      await db.todoList.updateMany({ where: base, data: { projectId: target } });
      return;
    }
    case "event": {
      const row = await db.event.findFirst({ where: { ...base, ...clientVisibleWhere(ctx) } });
      if (!row) throw notFound("Etkinlik bulunamadı.");
      if (!canModify(ctx, row.createdById)) throw forbidden();
      await db.event.updateMany({ where: base, data: { projectId: target } });
      return;
    }
    case "folder": {
      const row = await db.folder.findFirst({ where: { ...base, ...clientVisibleWhere(ctx) } });
      if (!row) throw notFound("Klasör bulunamadı.");
      if (!canModify(ctx, row.createdById)) throw forbidden();
      if (row.parentId) {
        throw new ServiceError("VALIDATION", "Alt klasörler üst klasörünün projesini izler.");
      }
      // Whole subtree follows the root folder.
      await db.$executeRaw`
        WITH RECURSIVE sub AS (
          SELECT id FROM "Folder" WHERE id = ${id} AND "workspaceId" = ${ctx.workspaceId}
          UNION ALL
          SELECT f.id FROM "Folder" f JOIN sub ON f."parentId" = sub.id WHERE f."workspaceId" = ${ctx.workspaceId}
        )
        UPDATE "Folder" SET "projectId" = ${target} WHERE id IN (SELECT id FROM sub)`;
      return;
    }
  }
}

export type ProjectOverview = {
  project: ProjectDTO;
  posts: { id: string; title: string; pinned: boolean; isDraft: boolean; createdAt: Date; authorId: string }[];
  todoLists: { id: string; name: string; total: number; done: number }[];
  folders: { id: string; name: string }[];
  events: { id: string; title: string; startsAt: Date; endsAt: Date; allDay: boolean; recurrence: string }[];
  counts: { posts: number; todoLists: number; folders: number; events: number };
};

/**
 * One project's items, each filtered by projectId (+ workspace, deletedAt IS NULL).
 * Posts honour draft visibility (visiblePostWhere). Folders are the project's
 * root folders (their subfolders and files live inside them).
 */
export async function getProjectOverview(ctx: TenantContext, slug: string): Promise<ProjectOverview> {
  const project = await getProject(ctx, slug);
  const scope = { workspaceId: ctx.workspaceId, projectId: project.id, deletedAt: null, ...clientVisibleWhere(ctx) };
  const postWhere: Prisma.PostWhereInput = { ...scope, ...visiblePostWhere(ctx) };
  const folderWhere = { ...scope, parentId: null };
  // The events preview shows what is still ahead (or recurring), not the oldest rows.
  const now = new Date();
  const eventWhere = { ...scope, OR: [{ recurrence: { not: "NONE" } }, { endsAt: { gte: now } }] };
  const [posts, lists, folders, events, postCount, listCount, folderCount, eventCount] = await Promise.all([
    db.post.findMany({
      where: postWhere,
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: OVERVIEW_TAKE,
      select: { id: true, title: true, pinned: true, publishedAt: true, createdAt: true, authorId: true },
    }),
    db.todoList.findMany({
      where: scope,
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: OVERVIEW_TAKE,
      select: { id: true, name: true },
    }),
    db.folder.findMany({
      where: folderWhere,
      orderBy: { name: "asc" },
      take: OVERVIEW_TAKE,
      select: { id: true, name: true },
    }),
    db.event.findMany({
      where: eventWhere,
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: OVERVIEW_TAKE,
      select: { id: true, title: true, startsAt: true, endsAt: true, allDay: true, recurrence: true },
    }),
    db.post.count({ where: postWhere }),
    db.todoList.count({ where: scope }),
    db.folder.count({ where: folderWhere }),
    db.event.count({ where: scope }),
  ]);
  const counts = lists.length
    ? await db.todoItem.groupBy({
        by: ["listId", "status"],
        where: { workspaceId: ctx.workspaceId, deletedAt: null, listId: { in: lists.map((l) => l.id) } },
        _count: { _all: true },
      })
    : [];
  const progress = new Map<string, { total: number; done: number }>();
  for (const c of counts) {
    const e = progress.get(c.listId) ?? { total: 0, done: 0 };
    e.total += c._count._all;
    if (c.status === "DONE") e.done += c._count._all;
    progress.set(c.listId, e);
  }
  return {
    project,
    posts: posts.map((p) => ({
      id: p.id,
      title: p.title,
      pinned: p.pinned,
      isDraft: p.publishedAt === null,
      createdAt: p.createdAt,
      authorId: p.authorId,
    })),
    todoLists: lists.map((l) => ({ id: l.id, name: l.name, ...(progress.get(l.id) ?? { total: 0, done: 0 }) })),
    folders,
    events,
    counts: { posts: postCount, todoLists: listCount, folders: folderCount, events: eventCount },
  };
}
