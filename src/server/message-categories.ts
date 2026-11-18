import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { hasRole } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { forbidden, notFound, parseInput } from "@/server/errors";

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
  const last = await db.messageCategory.findFirst({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return db.messageCategory.create({
    data: { ...data, workspaceId: ctx.workspaceId, position: (last?.position ?? -1) + 1 },
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
  const res = await db.messageCategory.deleteMany({ where: { id: categoryId, workspaceId: ctx.workspaceId } });
  if (res.count === 0) throw notFound("Kategori bulunamadı.");
}
