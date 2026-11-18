import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { dateOnlyToDb, dbToDateOnly, isDateOnly } from "@/lib/date-only";
import { db } from "@/lib/db";
import { canModify, hasRole } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { assertNotGuest } from "@/server/client-visibility";
import { conflict, forbidden, notFound, parseInput, ServiceError } from "@/server/errors";

/**
 * Card table (kanban). Every function is scoped by ctx.workspaceId.
 * Permissions: any member can create/edit/move cards; deleting a card needs
 * its author or an ADMIN/OWNER; columns are managed by ADMIN/OWNER.
 * Positions are always rewritten densely (0..n-1) under a per-workspace
 * advisory lock, like the to-do reorder.
 */

export const DEFAULT_CARD_COLUMNS = ["Triyaj", "Yapılıyor", "Bitti"] as const;

const MAX_COLUMNS = 20;
const MAX_CARDS_PER_COLUMN = 500;

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

const idSchema = z.string().min(1).max(64);
const columnNameSchema = z
  .string({ error: "Sütun adı gerekli." })
  .trim()
  .min(1, "Sütun adı gerekli.")
  .max(60, "Sütun adı en fazla 60 karakter olabilir.");
const titleSchema = z
  .string({ error: "Başlık gerekli." })
  .trim()
  .min(1, "Başlık gerekli.")
  .max(300, "Başlık en fazla 300 karakter olabilir.");
const notesSchema = z.preprocess(
  emptyToNull,
  z.string().trim().max(5000, "Notlar en fazla 5000 karakter olabilir.").nullable(),
);
const assigneeSchema = z.preprocess(emptyToNull, z.string().min(1).max(64).nullable());
const dueSchema = z.preprocess(
  emptyToNull,
  z.string().refine(isDateOnly, "Geçerli bir tarih girin.").nullable(),
);
const directionSchema = z.enum(["up", "down"], { error: "Geçersiz yön." });

const columnInputSchema = z.object({ name: columnNameSchema });
const createCardSchema = z.object({
  title: titleSchema,
  notes: notesSchema.optional(),
  assigneeId: assigneeSchema.optional(),
  dueOn: dueSchema.optional(),
});
const updateCardSchema = z.object({
  title: titleSchema.optional(),
  notes: notesSchema.optional(),
  assigneeId: assigneeSchema.optional(),
  dueOn: dueSchema.optional(),
});
const moveCardSchema = z
  .object({
    direction: directionSchema.optional(),
    columnId: idSchema.optional(),
    /** Target index inside the destination column; defaults to the end. */
    position: z.number().int().min(0).optional(),
  })
  .refine((v) => (v.direction === undefined) !== (v.columnId === undefined), {
    message: "Yön veya hedef sütun belirtin.",
  });

export type CardUser = { id: string; name: string | null; email: string; image: string | null };

export type CardDTO = {
  id: string;
  columnId: string;
  title: string;
  notes: string | null;
  assigneeId: string | null;
  assignee: CardUser | null;
  dueOn: string | null; // yyyy-MM-dd
  position: number;
  canDelete: boolean;
};

export type CardColumnDTO = { id: string; name: string; position: number; cards: CardDTO[] };

type Tx = Prisma.TransactionClient;
const userSelect = { id: true, name: true, email: true, image: true } as const;

async function lockPositions(tx: Tx, workspaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cards-positions:${workspaceId}`}))`;
}

function requireAdmin(ctx: TenantContext) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden("Sütunları yalnızca yöneticiler düzenleyebilir.");
}

async function requireAssignee(ctx: TenantContext, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  const member = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: assigneeId, workspaceId: ctx.workspaceId } },
    select: { id: true },
  });
  if (!member) {
    throw new ServiceError("VALIDATION", "Atanan kişi bu çalışma alanının üyesi olmalı.", {
      assigneeId: ["Atanan kişi bu çalışma alanının üyesi olmalı."],
    });
  }
}

/**
 * Seeds the default columns when the workspace has none. Idempotent (also
 * under concurrency, via the advisory lock), so it doubles as a lazy backfill.
 * Accepts a transaction client (createWorkspace) or the plain client.
 */
export async function ensureDefaultColumns(
  client: Tx | typeof db,
  workspaceId: string,
  createdById: string,
): Promise<void> {
  const seed = async (tx: Tx) => {
    await lockPositions(tx, workspaceId);
    if ((await tx.cardColumn.count({ where: { workspaceId } })) > 0) return;
    await tx.cardColumn.createMany({
      data: DEFAULT_CARD_COLUMNS.map((name, position) => ({ workspaceId, name, position, createdById })),
    });
  };
  if ("$transaction" in client) await client.$transaction(seed);
  else await seed(client);
}

function toCardDTO(
  ctx: TenantContext,
  c: {
    id: string;
    columnId: string;
    title: string;
    notes: string | null;
    assigneeId: string | null;
    assignee: CardUser | null;
    dueOn: Date | null;
    position: number;
    createdById: string;
  },
): CardDTO {
  return {
    id: c.id,
    columnId: c.columnId,
    title: c.title,
    notes: c.notes,
    assigneeId: c.assigneeId,
    assignee: c.assignee,
    dueOn: c.dueOn ? dbToDateOnly(c.dueOn) : null,
    position: c.position,
    canDelete: canModify(ctx, c.createdById),
  };
}

/** The board: columns in order, each with its non-deleted cards in order. */
export async function listBoard(ctx: TenantContext): Promise<CardColumnDTO[]> {
  assertNotGuest(ctx, "Kart tablosu yalnızca ekibe açıktır.");
  await ensureDefaultColumns(db, ctx.workspaceId, ctx.userId);
  const columns = await db.cardColumn.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: MAX_COLUMNS,
    select: {
      id: true,
      name: true,
      position: true,
      cards: {
        where: { deletedAt: null, workspaceId: ctx.workspaceId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: MAX_CARDS_PER_COLUMN,
        select: {
          id: true,
          columnId: true,
          title: true,
          notes: true,
          assigneeId: true,
          assignee: { select: userSelect },
          dueOn: true,
          position: true,
          createdById: true,
        },
      },
    },
  });
  return columns.map((col) => ({
    id: col.id,
    name: col.name,
    position: col.position,
    cards: col.cards.map((c) => toCardDTO(ctx, c)),
  }));
}

// ------------------------------------------------------------- columns ----

function orderedColumns(tx: Tx, workspaceId: string) {
  return tx.cardColumn.findMany({
    where: { workspaceId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, position: true },
  });
}

async function writeColumnPositions(tx: Tx, workspaceId: string, rows: { id: string; position: number }[]) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].position === i) continue;
    await tx.cardColumn.updateMany({ where: { id: rows[i].id, workspaceId }, data: { position: i } });
  }
}

export async function createColumn(ctx: TenantContext, input: unknown) {
  assertNotGuest(ctx, "Kart tablosu yalnızca ekibe açıktır.");
  requireAdmin(ctx);
  const data = parseInput(columnInputSchema, input);
  return db.$transaction(async (tx) => {
    await lockPositions(tx, ctx.workspaceId);
    const count = await tx.cardColumn.count({ where: { workspaceId: ctx.workspaceId } });
    if (count >= MAX_COLUMNS) throw conflict(`En fazla ${MAX_COLUMNS} sütun oluşturabilirsiniz.`);
    const max = await tx.cardColumn.aggregate({
      where: { workspaceId: ctx.workspaceId },
      _max: { position: true },
    });
    return tx.cardColumn.create({
      data: {
        workspaceId: ctx.workspaceId,
        createdById: ctx.userId,
        name: data.name,
        position: (max._max.position ?? -1) + 1,
      },
    });
  });
}

export async function renameColumn(ctx: TenantContext, columnId: string, input: unknown) {
  assertNotGuest(ctx, "Kart tablosu yalnızca ekibe açıktır.");
  requireAdmin(ctx);
  const data = parseInput(columnInputSchema, input);
  const res = await db.cardColumn.updateMany({
    where: { id: columnId, workspaceId: ctx.workspaceId },
    data: { name: data.name },
  });
  if (res.count === 0) throw notFound("Sütun bulunamadı.");
}

/** Moves a column one step left ("up") or right ("down"); positions stay dense. */
export async function moveColumn(ctx: TenantContext, columnId: string, direction: unknown) {
  assertNotGuest(ctx, "Kart tablosu yalnızca ekibe açıktır.");
  requireAdmin(ctx);
  const dir = parseInput(directionSchema, direction);
  await db.$transaction(async (tx) => {
    await lockPositions(tx, ctx.workspaceId);
    const rows = await orderedColumns(tx, ctx.workspaceId);
    const index = rows.findIndex((r) => r.id === columnId);
    if (index === -1) throw notFound("Sütun bulunamadı.");
    const j = dir === "up" ? index - 1 : index + 1;
    if (j >= 0 && j < rows.length) {
      const [x] = rows.splice(index, 1);
      rows.splice(j, 0, x);
    }
    await writeColumnPositions(tx, ctx.workspaceId, rows);
  });
}

/** A column can only be deleted when it holds no (non-deleted) cards. */
export async function deleteColumn(ctx: TenantContext, columnId: string) {
  assertNotGuest(ctx, "Kart tablosu yalnızca ekibe açıktır.");
  requireAdmin(ctx);
  await db.$transaction(async (tx) => {
    await lockPositions(tx, ctx.workspaceId);
    const col = await tx.cardColumn.findFirst({ where: { id: columnId, workspaceId: ctx.workspaceId } });
    if (!col) throw notFound("Sütun bulunamadı.");
    const cards = await tx.card.count({ where: { columnId, workspaceId: ctx.workspaceId, deletedAt: null } });
    if (cards > 0) throw conflict("Önce sütundaki kartları taşıyın veya silin.");
    await tx.cardColumn.delete({ where: { id: columnId } });
    await writeColumnPositions(tx, ctx.workspaceId, await orderedColumns(tx, ctx.workspaceId));
  });
}

// --------------------------------------------------------------- cards ----

function orderedCardIds(tx: Tx, workspaceId: string, columnId: string) {
  return tx.card.findMany({
    where: { workspaceId, columnId, deletedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, position: true },
  });
}

async function writeCardPositions(
  tx: Tx,
  workspaceId: string,
  columnId: string,
  rows: { id: string; position: number }[],
) {
  for (let i = 0; i < rows.length; i++) {
    await tx.card.updateMany({ where: { id: rows[i].id, workspaceId }, data: { columnId, position: i } });
  }
}

async function getCard(ctx: TenantContext, cardId: string, tx: Tx | typeof db = db) {
  const card = await tx.card.findFirst({ where: { id: cardId, workspaceId: ctx.workspaceId, deletedAt: null } });
  if (!card) throw notFound("Kart bulunamadı.");
  return card;
}

export async function createCard(ctx: TenantContext, columnId: string, input: unknown) {
  assertNotGuest(ctx, "Kart tablosu yalnızca ekibe açıktır.");
  const data = parseInput(createCardSchema, input);
  await requireAssignee(ctx, data.assigneeId);
  return db.$transaction(async (tx) => {
    await lockPositions(tx, ctx.workspaceId);
    const col = await tx.cardColumn.findFirst({ where: { id: columnId, workspaceId: ctx.workspaceId } });
    if (!col) throw notFound("Sütun bulunamadı.");
    const count = await tx.card.count({ where: { columnId, workspaceId: ctx.workspaceId, deletedAt: null } });
    if (count >= MAX_CARDS_PER_COLUMN) throw conflict(`Bir sütunda en fazla ${MAX_CARDS_PER_COLUMN} kart olabilir.`);
    return tx.card.create({
      data: {
        workspaceId: ctx.workspaceId,
        columnId,
        createdById: ctx.userId,
        title: data.title,
        notes: data.notes ?? null,
        assigneeId: data.assigneeId ?? null,
        dueOn: data.dueOn ? dateOnlyToDb(data.dueOn) : null,
        position: count,
      },
    });
  });
}

export async function updateCard(ctx: TenantContext, cardId: string, input: unknown) {
  assertNotGuest(ctx, "Kart tablosu yalnızca ekibe açıktır.");
  const data = parseInput(updateCardSchema, input);
  await getCard(ctx, cardId);
  await requireAssignee(ctx, data.assigneeId);
  const res = await db.card.updateMany({
    where: { id: cardId, workspaceId: ctx.workspaceId, deletedAt: null },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.assigneeId !== undefined ? { assigneeId: data.assigneeId } : {}),
      ...(data.dueOn !== undefined ? { dueOn: data.dueOn ? dateOnlyToDb(data.dueOn) : null } : {}),
    },
  });
  if (res.count === 0) throw notFound("Kart bulunamadı.");
}

/**
 * Moves a card: `direction` reorders inside its column; `columnId` (+ optional
 * `position`, default end) moves it to another column. Both columns stay dense.
 */
export async function moveCard(ctx: TenantContext, cardId: string, input: unknown) {
  assertNotGuest(ctx, "Kart tablosu yalnızca ekibe açıktır.");
  const data = parseInput(moveCardSchema, input);
  await db.$transaction(async (tx) => {
    await lockPositions(tx, ctx.workspaceId);
    const card = await getCard(ctx, cardId, tx);
    if (data.direction) {
      const rows = await orderedCardIds(tx, ctx.workspaceId, card.columnId);
      const index = rows.findIndex((r) => r.id === cardId);
      const j = data.direction === "up" ? index - 1 : index + 1;
      if (index === -1 || j < 0 || j >= rows.length) return;
      const [x] = rows.splice(index, 1);
      rows.splice(j, 0, x);
      await writeCardPositions(tx, ctx.workspaceId, card.columnId, rows);
      return;
    }
    const target = await tx.cardColumn.findFirst({ where: { id: data.columnId!, workspaceId: ctx.workspaceId } });
    if (!target) throw notFound("Sütun bulunamadı.");
    const sourceRows = (await orderedCardIds(tx, ctx.workspaceId, card.columnId)).filter((r) => r.id !== cardId);
    const sameColumn = target.id === card.columnId;
    const targetRows = sameColumn ? sourceRows : await orderedCardIds(tx, ctx.workspaceId, target.id);
    if (!sameColumn && targetRows.length >= MAX_CARDS_PER_COLUMN) {
      throw conflict(`Bir sütunda en fazla ${MAX_CARDS_PER_COLUMN} kart olabilir.`);
    }
    const at = Math.min(data.position ?? targetRows.length, targetRows.length);
    targetRows.splice(at, 0, { id: cardId, position: -1 });
    await writeCardPositions(tx, ctx.workspaceId, target.id, targetRows);
    if (!sameColumn) await writeCardPositions(tx, ctx.workspaceId, card.columnId, sourceRows);
  });
}

export async function deleteCard(ctx: TenantContext, cardId: string) {
  assertNotGuest(ctx, "Kart tablosu yalnızca ekibe açıktır.");
  await db.$transaction(async (tx) => {
    await lockPositions(tx, ctx.workspaceId);
    const card = await getCard(ctx, cardId, tx);
    if (!canModify(ctx, card.createdById)) throw forbidden("Bu kartı silme yetkiniz yok.");
    await tx.card.updateMany({
      where: { id: cardId, workspaceId: ctx.workspaceId, deletedAt: null },
      data: { deletedAt: new Date(), deletedById: ctx.userId },
    });
    await writeCardPositions(
      tx,
      ctx.workspaceId,
      card.columnId,
      await orderedCardIds(tx, ctx.workspaceId, card.columnId),
    );
  });
}
