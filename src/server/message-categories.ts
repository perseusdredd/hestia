import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { hasRole } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { conflict, forbidden, notFound, parseInput } from "@/server/errors";

export const DEFAULT_MESSAGE_CATEGORIES = [
  { name: "Duyuru", emoji: "📢" },
  { name: "Bilgi", emoji: "💡" },
  { name: "Soru", emoji: "❓" },
  { name: "Fikir", emoji: "🔥" },
  { name: "Günlük Durum", emoji: "🗒️" },
] as const;

const MAX_CATEGORIES = 30;

const categorySchema = z.object({
  name: z.string().trim().min(1, "Kategori adı gerekli.").max(40, "Kategori adı en fazla 40 karakter olabilir."),
  emoji: z.string().trim().min(1, "Emoji gerekli.").max(16, "Emoji çok uzun."),
});

export type MessageCategoryDto = { id: string; name: string; emoji: string; position: number };

/**
 * Seeds the default categories when the workspace has none. Idempotent, so it
 * doubles as a lazy backfill. Accepts a transaction client.
 */
export async function ensureDefaultCategories(
  client: Prisma.TransactionClient | typeof db,
  workspaceId: string,
): Promise<void> {
  const existing = await client.messageCategory.count({ where: { workspaceId } });
  if (existing > 0) return;
  await client.messageCategory.createMany({
    data: DEFAULT_MESSAGE_CATEGORIES.map((c, position) => ({ workspaceId, name: c.name, emoji: c.emoji, position })),
  });
}

export async function listCategories(ctx: TenantContext): Promise<MessageCategoryDto[]> {
  return db.messageCategory.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, name: true, emoji: true, position: true },
    take: MAX_CATEGORIES,
  });
}

function requireAdmin(ctx: TenantContext) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden("Kategorileri yalnızca yöneticiler düzenleyebilir.");
}

export async function createCategory(ctx: TenantContext, input: unknown) {
  requireAdmin(ctx);
  const data = parseInput(categorySchema, input);
  return db.$transaction(async (tx) => {
    await lockCategoryPositions(tx, ctx.workspaceId);
    const count = await tx.messageCategory.count({ where: { workspaceId: ctx.workspaceId } });
    if (count >= MAX_CATEGORIES) throw conflict(`En fazla ${MAX_CATEGORIES} kategori oluşturabilirsiniz.`);
    const last = await tx.messageCategory.findFirst({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    return tx.messageCategory.create({
      data: { ...data, workspaceId: ctx.workspaceId, position: (last?.position ?? -1) + 1 },
    });
  });
}

export async function updateCategory(ctx: TenantContext, categoryId: string, input: unknown) {
  requireAdmin(ctx);
  const data = parseInput(categorySchema, input);
  const res = await db.messageCategory.updateMany({
    where: { id: categoryId, workspaceId: ctx.workspaceId },
    data,
  });
  if (res.count === 0) throw notFound("Kategori bulunamadı.");
}

/** Posts in the category keep existing (their categoryId becomes null). */
export async function deleteCategory(ctx: TenantContext, categoryId: string) {
  requireAdmin(ctx);
  await db.$transaction(async (tx) => {
    await lockCategoryPositions(tx, ctx.workspaceId);
    const res = await tx.messageCategory.deleteMany({ where: { id: categoryId, workspaceId: ctx.workspaceId } });
    if (res.count === 0) throw notFound("Kategori bulunamadı.");
    await renumber(tx, ctx.workspaceId);
  });
}

const directionSchema = z.enum(["up", "down"], { error: "Geçersiz yön." });

/** Moves a category one step up/down; positions stay dense (0..n-1). */
export async function moveCategory(ctx: TenantContext, categoryId: string, direction: unknown) {
  requireAdmin(ctx);
  const dir = parseInput(directionSchema, direction);
  await db.$transaction(async (tx) => {
    await lockCategoryPositions(tx, ctx.workspaceId);
    const rows = await orderedRows(tx, ctx.workspaceId);
    const index = rows.findIndex((r) => r.id === categoryId);
    if (index === -1) throw notFound("Kategori bulunamadı.");
    const j = dir === "up" ? index - 1 : index + 1;
    if (j >= 0 && j < rows.length) {
      const [x] = rows.splice(index, 1);
      rows.splice(j, 0, x);
    }
    await writePositions(tx, ctx.workspaceId, rows);
  });
}

/** Serialises position changes per workspace (works even with zero rows). */
async function lockCategoryPositions(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`messagecategory-positions:${workspaceId}`}))`;
}

function orderedRows(tx: Prisma.TransactionClient, workspaceId: string) {
  return tx.messageCategory.findMany({
    where: { workspaceId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, position: true },
  });
}

async function writePositions(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  rows: { id: string; position: number }[],
) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].position === i) continue;
    await tx.messageCategory.updateMany({ where: { id: rows[i].id, workspaceId }, data: { position: i } });
  }
}

async function renumber(tx: Prisma.TransactionClient, workspaceId: string) {
  await writePositions(tx, workspaceId, await orderedRows(tx, workspaceId));
}
