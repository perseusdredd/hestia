import { z } from "zod";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { NOTIFICATION_TYPES, type NotificationType } from "@/server/notifications";
import { parseInput } from "@/server/errors";

/**
 * Per-user notification preferences ("Bildirim tercihleri"), per workspace.
 * A row only stores the MUTED types; no row means everything is on. notify()
 * drops muted recipients before writing.
 */

const typesSchema = z.array(z.enum(NOTIFICATION_TYPES, { error: "Geçersiz bildirim türü." })).max(50);

/** The caller's muted notification types in this workspace (empty = all on). */
export async function getMutedTypes(ctx: TenantContext): Promise<NotificationType[]> {
  const row = await db.notificationPreference.findUnique({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
    select: { mutedTypes: true },
  });
  const known = new Set<string>(NOTIFICATION_TYPES);
  return (row?.mutedTypes ?? []).filter((t): t is NotificationType => known.has(t));
}

/** Replace the caller's muted types in this workspace. Unknown types are rejected. */
export async function setMutedTypes(ctx: TenantContext, types: unknown): Promise<NotificationType[]> {
  const parsed = [...new Set(parseInput(typesSchema, types))];
  await db.notificationPreference.upsert({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
    create: { userId: ctx.userId, workspaceId: ctx.workspaceId, mutedTypes: parsed },
    update: { mutedTypes: parsed },
  });
  return parsed;
}
