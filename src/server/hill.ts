import { z } from "zod";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { clientVisibleWhere } from "@/lib/roles";
import { assertNotGuest } from "@/server/client-visibility";
import { recordActivity } from "@/server/activity";
import { notFound, parseInput } from "@/server/errors";

/**
 * Hill charts on to-do lists. A list has a position 0-100: 0-50 is the uphill
 * ("figuring it out"), 50-100 the downhill ("making it happen"). Every update
 * is also stored as a HillSnapshot. Any member can update; everything is
 * scoped by ctx.workspaceId and trashed lists are not found.
 */

export const HILL_NOTE_MAX = 500;
export const HILL_HISTORY_LIMIT = 50;

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

const hillSchema = z.object({
  position: z.coerce
    .number({ message: "Geçerli bir konum girin." })
    .int("Konum tam sayı olmalı.")
    .min(0, "Konum 0 ile 100 arasında olmalı.")
    .max(100, "Konum 0 ile 100 arasında olmalı."),
  note: z.preprocess(
    emptyToNull,
    z.string().trim().max(HILL_NOTE_MAX, `Not en fazla ${HILL_NOTE_MAX} karakter olabilir.`).nullable(),
  ),
});

export type HillSnapshotDTO = {
  id: string;
  position: number;
  note: string | null;
  createdAt: string;
  createdById: string;
  createdByName: string | null;
};

export function hillPhase(position: number): "uphill" | "downhill" {
  return position <= 50 ? "uphill" : "downhill";
}

export async function setHillPosition(
  ctx: TenantContext,
  listId: string,
  position: unknown,
  note?: unknown,
) {
  assertNotGuest(ctx, "Misafirler ilerleme grafiğini güncelleyemez.");
  const data = parseInput(hillSchema, { position, note: note ?? null });
  const list = await db.todoList.findFirst({
    where: { id: listId, workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
    select: { id: true, name: true },
  });
  if (!list) throw notFound("Liste bulunamadı.");

  await db.$transaction([
    db.todoList.update({
      where: { id: list.id },
      data: { hillPosition: data.position, hillNote: data.note },
    }),
    db.hillSnapshot.create({
      data: {
        workspaceId: ctx.workspaceId,
        listId: list.id,
        position: data.position,
        note: data.note,
        createdById: ctx.userId,
      },
    }),
  ]);

  await recordActivity(ctx, {
    type: "HILL_UPDATED",
    title: list.name,
    path: "todos",
    subject: { type: "todoList", id: list.id },
  });
}

export async function getHillHistory(ctx: TenantContext, listId: string): Promise<HillSnapshotDTO[]> {
  const list = await db.todoList.findFirst({
    where: { id: listId, workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
    select: { id: true },
  });
  if (!list) throw notFound("Liste bulunamadı.");
  const rows = await db.hillSnapshot.findMany({
    where: { workspaceId: ctx.workspaceId, listId: list.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: HILL_HISTORY_LIMIT,
  });
  const userIds = [...new Set(rows.map((r) => r.createdById))];
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : [];
  const names = new Map(users.map((u) => [u.id, u.name?.trim() || u.email.split("@")[0]]));
  return rows.map((r) => ({
    id: r.id,
    position: r.position,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    createdById: r.createdById,
    createdByName: names.get(r.createdById) ?? null,
  }));
}
