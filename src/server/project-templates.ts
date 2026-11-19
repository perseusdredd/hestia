import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { hasRole } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { forbidden, notFound, parseInput, ServiceError } from "@/server/errors";
import { insertProjectTx, lockProjects, type ProjectDTO } from "@/server/projects";

/**
 * Project templates (Basecamp "project templates"), ADDITIVE on top of projects.
 * A template is a Project row with isTemplate = true whose structure lives in a
 * JSON skeleton (templateSpec): to-do lists (sections + items), folders (names
 * only, never file bytes) and starter message titles. Because the skeleton is
 * not stored as real posts/lists/folders, templates can never leak into any
 * workspace-wide listing, search or overview; and the project queries in
 * projects.ts exclude isTemplate rows. Everything is scoped by ctx.workspaceId
 * and needs ADMIN or OWNER (guests and members never see templates).
 */

const MAX_TEMPLATES = 50;
const MAX_LISTS = 50;
const MAX_ITEMS_PER_LIST = 500;
const MAX_FOLDERS = 200;
const MAX_POSTS = 50;
const STARTER_BODY = "Şablondan oluşturulan taslak. Yayınlamadan önce içeriği düzenleyin.";

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const nameSchema = z
  .string({ error: "Ad gerekli." })
  .trim()
  .min(1, "Ad gerekli.")
  .max(80, "Ad en fazla 80 karakter olabilir.");
const descriptionSchema = z.preprocess(
  emptyToNull,
  z.string().trim().max(2000, "Açıklama en fazla 2000 karakter olabilir.").nullable(),
);
const idSchema = z.string().trim().min(1, "Geçersiz kayıt.").max(64, "Geçersiz kayıt.");

const createTemplateSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional(),
  /** When set, the template is a structure-only deep copy of this project. */
  fromProjectId: idSchema.nullish(),
});
const saveAsSchema = z.object({ name: nameSchema.optional(), description: descriptionSchema.optional() });
const renameTemplateSchema = z.object({ name: nameSchema.optional(), description: descriptionSchema.optional() });
const fromTemplateSchema = z.object({ name: nameSchema, description: descriptionSchema.optional() });

// ---- skeleton ----------------------------------------------------------------

type FolderNode = { name: string; internal: boolean; children: FolderNode[] };
type TemplateSpec = {
  lists: {
    name: string;
    description: string | null;
    internal: boolean;
    sections: string[];
    items: { title: string; notes: string | null; section: number | null }[];
  }[];
  folders: FolderNode[];
  posts: { title: string; internal: boolean }[];
};

const folderNodeSchema: z.ZodType<FolderNode> = z.lazy(() =>
  z.object({ name: z.string(), internal: z.boolean().catch(false), children: z.array(folderNodeSchema).catch([]) }),
);
const specSchema = z.object({
  lists: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().nullable().catch(null),
        internal: z.boolean().catch(false),
        sections: z.array(z.string()).catch([]),
        items: z
          .array(
            z.object({
              title: z.string(),
              notes: z.string().nullable().catch(null),
              section: z.number().int().nullable().catch(null),
            }),
          )
          .catch([]),
      }),
    )
    .catch([]),
  folders: z.array(folderNodeSchema).catch([]),
  posts: z.array(z.object({ title: z.string(), internal: z.boolean().catch(false) })).catch([]),
});

const EMPTY_SPEC: TemplateSpec = { lists: [], folders: [], posts: [] };

function readSpec(raw: unknown): TemplateSpec {
  const parsed = specSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_SPEC;
}

function countFolders(nodes: FolderNode[]): number {
  return nodes.reduce((n, f) => n + 1 + countFolders(f.children), 0);
}

export type ProjectTemplateDTO = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: Date;
  counts: { todoLists: number; todoItems: number; folders: number; posts: number };
};

function toDTO(t: {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: Date;
  templateSpec: unknown;
}): ProjectTemplateDTO {
  const spec = readSpec(t.templateSpec);
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    description: t.description,
    createdAt: t.createdAt,
    counts: {
      todoLists: spec.lists.length,
      todoItems: spec.lists.reduce((n, l) => n + l.items.length, 0),
      folders: countFolders(spec.folders),
      posts: spec.posts.length,
    },
  };
}

function requireAdmin(ctx: TenantContext) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden("Şablonları yalnızca yöneticiler yönetebilir.");
}

async function findTemplate(ctx: TenantContext, id: string) {
  const t = await db.project.findFirst({
    where: { id: parseInput(idSchema, id), workspaceId: ctx.workspaceId, isTemplate: true },
  });
  if (!t) throw notFound("Şablon bulunamadı.");
  return t;
}

/** Reads a REAL project's structure (ids dropped; assignees, dates and file bytes are never read). */
async function snapshotProject(ctx: TenantContext, projectId: string): Promise<TemplateSpec> {
  const project = await db.project.findFirst({
    where: { id: projectId, workspaceId: ctx.workspaceId, isTemplate: false },
    select: { id: true },
  });
  if (!project) throw notFound("Proje bulunamadı.");
  const scope = { workspaceId: ctx.workspaceId, projectId: project.id, deletedAt: null };
  const order = [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }] as const;

  const lists = await db.todoList.findMany({
    where: scope,
    orderBy: [...order],
    take: MAX_LISTS,
    select: {
      name: true,
      description: true,
      internal: true,
      sections: { orderBy: [...order], select: { id: true, name: true } },
      items: {
        where: { deletedAt: null },
        orderBy: [...order],
        take: MAX_ITEMS_PER_LIST,
        select: { title: true, notes: true, sectionId: true },
      },
    },
  });

  const folderRows = await db.folder.findMany({
    where: scope,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: MAX_FOLDERS,
    select: { id: true, parentId: true, name: true, internal: true },
  });
  const nodes = new Map<string, FolderNode & { parentId: string | null }>();
  for (const f of folderRows) nodes.set(f.id, { name: f.name, internal: f.internal, children: [], parentId: f.parentId });
  const roots: FolderNode[] = [];
  for (const n of nodes.values()) {
    if (n.parentId === null) roots.push(n);
    else nodes.get(n.parentId)?.children.push(n);
  }

  const posts = await db.post.findMany({
    where: { ...scope, publishedAt: { not: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_POSTS,
    select: { title: true, internal: true },
  });

  const strip = (n: FolderNode): FolderNode => ({ name: n.name, internal: n.internal, children: n.children.map(strip) });
  return {
    lists: lists.map((l) => {
      const index = new Map(l.sections.map((s, i) => [s.id, i]));
      return {
        name: l.name,
        description: l.description,
        internal: l.internal,
        sections: l.sections.map((s) => s.name),
        items: l.items.map((i) => ({
          title: i.title,
          notes: i.notes,
          section: i.sectionId ? (index.get(i.sectionId) ?? null) : null,
        })),
      };
    }),
    folders: roots.map(strip),
    posts: posts.map((p) => ({ title: p.title, internal: p.internal })),
  };
}

// ---- management ----------------------------------------------------------------

/** Blank template, or (fromProjectId) a structure-only deep copy of a project. */
export async function createTemplate(ctx: TenantContext, input: unknown): Promise<ProjectTemplateDTO> {
  requireAdmin(ctx);
  const data = parseInput(createTemplateSchema, input);
  const spec = data.fromProjectId ? await snapshotProject(ctx, data.fromProjectId) : EMPTY_SPEC;
  const row = await db.$transaction(async (tx) => {
    await lockProjects(tx, ctx.workspaceId);
    const count = await tx.project.count({ where: { workspaceId: ctx.workspaceId, isTemplate: true } });
    if (count >= MAX_TEMPLATES) {
      throw new ServiceError("VALIDATION", `Bir alanda en fazla ${MAX_TEMPLATES} şablon olabilir.`);
    }
    return insertProjectTx(tx, ctx, {
      name: data.name,
      description: data.description ?? null,
      isTemplate: true,
      templateSpec: spec as unknown as Prisma.InputJsonValue,
    });
  });
  return toDTO(row);
}

/** "Şablon olarak kaydet": template named after the project unless a name is given. */
export async function saveProjectAsTemplate(
  ctx: TenantContext,
  projectId: string,
  input: unknown = {},
): Promise<ProjectTemplateDTO> {
  requireAdmin(ctx);
  const project = await db.project.findFirst({
    where: { id: parseInput(idSchema, projectId), workspaceId: ctx.workspaceId, isTemplate: false },
    select: { id: true, name: true, description: true },
  });
  if (!project) throw notFound("Proje bulunamadı.");
  const data = parseInput(saveAsSchema, input ?? {});
  return createTemplate(ctx, {
    name: data.name ?? project.name,
    description: data.description !== undefined ? data.description : project.description,
    fromProjectId: project.id,
  });
}

/** ADMIN+ only; everyone else gets an empty list so nothing can leak. */
export async function listTemplates(ctx: TenantContext): Promise<ProjectTemplateDTO[]> {
  if (!hasRole(ctx.role, "ADMIN")) return [];
  const rows = await db.project.findMany({
    where: { workspaceId: ctx.workspaceId, isTemplate: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toDTO);
}

export async function getTemplate(ctx: TenantContext, id: string): Promise<ProjectTemplateDTO> {
  requireAdmin(ctx);
  return toDTO(await findTemplate(ctx, id));
}

export async function renameTemplate(ctx: TenantContext, id: string, input: unknown): Promise<ProjectTemplateDTO> {
  requireAdmin(ctx);
  const data = parseInput(renameTemplateSchema, input);
  await findTemplate(ctx, id);
  const res = await db.project.updateMany({
    where: { id, workspaceId: ctx.workspaceId, isTemplate: true },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
    },
  });
  if (res.count === 0) throw notFound("Şablon bulunamadı.");
  return toDTO(await findTemplate(ctx, id));
}

export async function deleteTemplate(ctx: TenantContext, id: string): Promise<void> {
  requireAdmin(ctx);
  await findTemplate(ctx, id);
  await db.project.deleteMany({ where: { id, workspaceId: ctx.workspaceId, isTemplate: true } });
}

// ---- instantiate ----------------------------------------------------------------

async function uniqueRootFolderName(tx: Prisma.TransactionClient, ctx: TenantContext, name: string) {
  const rows = await tx.folder.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      parentId: null,
      deletedAt: null,
      name: { startsWith: name, mode: "insensitive" },
    },
    select: { name: true },
  });
  const taken = new Set(rows.map((r) => r.name.toLowerCase()));
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
  return candidate;
}

/**
 * New, independent project from a template: new ids, this workspace, projectId
 * wired, positions dense, nothing assigned, no dates, starter messages stay
 * drafts (publishedAt null) authored by the caller.
 */
export async function createProjectFromTemplate(
  ctx: TenantContext,
  templateId: string,
  input: unknown,
): Promise<ProjectDTO> {
  requireAdmin(ctx);
  const data = parseInput(fromTemplateSchema, input);
  const template = await findTemplate(ctx, templateId);
  const spec = readSpec(template.templateSpec);

  const project = await db.$transaction(
    async (tx) => {
      await lockProjects(tx, ctx.workspaceId);
      const created = await insertProjectTx(tx, ctx, {
        name: data.name,
        description: data.description !== undefined ? data.description : template.description,
      });
      const base = { workspaceId: ctx.workspaceId, projectId: created.id, createdById: ctx.userId };

      if (spec.lists.length > 0) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`todolist-positions:${ctx.workspaceId}`}))`;
        const max = await tx.todoList.aggregate({ where: { workspaceId: ctx.workspaceId }, _max: { position: true } });
        let pos = (max._max.position ?? -1) + 1;
        for (const l of spec.lists) {
          const list = await tx.todoList.create({
            data: { ...base, name: l.name, description: l.description, internal: l.internal, position: pos++ },
          });
          const sectionIds: string[] = [];
          for (const [i, name] of l.sections.entries()) {
            const s = await tx.todoSection.create({
              data: { workspaceId: ctx.workspaceId, listId: list.id, name, position: i },
            });
            sectionIds.push(s.id);
          }
          if (l.items.length > 0) {
            await tx.todoItem.createMany({
              data: l.items.map((it, i) => ({
                workspaceId: ctx.workspaceId,
                listId: list.id,
                createdById: ctx.userId,
                title: it.title,
                notes: it.notes,
                sectionId: it.section !== null ? (sectionIds[it.section] ?? null) : null,
                status: "OPEN" as const,
                position: i,
              })),
            });
          }
        }
      }

      if (spec.folders.length > 0) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"hestia:folders:" + ctx.workspaceId}))`;
        const make = async (node: FolderNode, parentId: string | null): Promise<void> => {
          const name = parentId ? node.name : await uniqueRootFolderName(tx, ctx, node.name);
          const f = await tx.folder.create({
            data: {
              workspaceId: ctx.workspaceId,
              projectId: created.id,
              parentId,
              createdById: ctx.userId,
              name,
              internal: node.internal,
            },
          });
          for (const c of node.children) await make(c, f.id);
        };
        for (const root of spec.folders) await make(root, null);
      }

      if (spec.posts.length > 0) {
        await tx.post.createMany({
          data: spec.posts.map((p) => ({
            workspaceId: ctx.workspaceId,
            projectId: created.id,
            authorId: ctx.userId,
            title: p.title,
            body: STARTER_BODY,
            internal: p.internal,
            publishedAt: null,
            scheduledFor: null,
          })),
        });
      }
      return created;
    },
    { timeout: 30_000 },
  );

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    archived: project.archived,
    position: project.position,
    createdAt: project.createdAt,
  };
}
