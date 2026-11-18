import { z } from "zod";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { notFound, parseInput } from "@/server/errors";
import { visiblePostWhere } from "@/server/post-visibility";

/**
 * Per-item follow ("Aboneler") for posts, to-dos and events.
 *
 * A subscriber gets the comment notifications of the item. Authors, assignees,
 * commenters and @mentioned members are subscribed automatically; anyone can
 * subscribe or unsubscribe themselves. The subject is polymorphic (no FK), so
 * every call first loads it scoped by ctx.workspaceId (NOT_FOUND otherwise),
 * and subscriber ids are always filtered to CURRENT members.
 */

export const SUBSCRIPTION_SUBJECT_TYPES = ["post", "todo", "event"] as const;
export type SubscriptionSubjectType = (typeof SUBSCRIPTION_SUBJECT_TYPES)[number];
export type SubscriptionSubject = { type: SubscriptionSubjectType; id: string };

const subjectSchema = z.object({
  type: z.enum(SUBSCRIPTION_SUBJECT_TYPES, { error: "Geçersiz abonelik konusu." }),
  id: z.string({ error: "Kayıt bulunamadı." }).min(1, "Kayıt bulunamadı.").max(64, "Kayıt bulunamadı."),
});

const MAX_SUBSCRIBERS = 5000;

async function requireSubject(ctx: TenantContext, input: unknown): Promise<SubscriptionSubject> {
  const s = parseInput(subjectSchema, input);
  const where = { id: s.id, workspaceId: ctx.workspaceId, deletedAt: null };
  let found: { id: string } | null = null;
  switch (s.type) {
    case "post":
      found = await db.post.findFirst({ where: { ...where, ...visiblePostWhere(ctx) }, select: { id: true } });
      break;
    case "todo":
      found = await db.todoItem.findFirst({
        where: { ...where, list: { workspaceId: ctx.workspaceId, deletedAt: null } },
        select: { id: true },
      });
      break;
    case "event":
      found = await db.event.findFirst({ where, select: { id: true } });
      break;
  }
  if (!found) throw notFound("Kayıt bulunamadı.");
  return s;
}

/** Current subscribers of an item (members only). Callers have loaded the subject already. */
export async function listSubscriberIds(ctx: TenantContext, subject: SubscriptionSubject): Promise<string[]> {
  const rows = await db.subscription.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      subjectType: subject.type,
      subjectId: subject.id,
      user: { memberships: { some: { workspaceId: ctx.workspaceId } } },
    },
    select: { userId: true },
    take: MAX_SUBSCRIBERS,
  });
  return rows.map((r) => r.userId);
}

/** Is the caller subscribed? NOT_FOUND when the subject is not in ctx's workspace. */
export async function isSubscribed(ctx: TenantContext, subject: unknown): Promise<boolean> {
  const s = await requireSubject(ctx, subject);
  const row = await db.subscription.findFirst({
    where: { userId: ctx.userId, subjectType: s.type, subjectId: s.id, workspaceId: ctx.workspaceId },
    select: { id: true },
  });
  return row !== null;
}

/** Number of subscribers, for the detail pages. */
export async function countSubscribers(ctx: TenantContext, subject: SubscriptionSubject): Promise<number> {
  return (await listSubscriberIds(ctx, subject)).length;
}

export async function subscribe(ctx: TenantContext, subject: unknown): Promise<SubscriptionSubject> {
  const s = await requireSubject(ctx, subject);
  await db.subscription.createMany({
    data: [{ workspaceId: ctx.workspaceId, userId: ctx.userId, subjectType: s.type, subjectId: s.id }],
    skipDuplicates: true,
  });
  return s;
}

export async function unsubscribe(ctx: TenantContext, subject: unknown): Promise<SubscriptionSubject> {
  const s = await requireSubject(ctx, subject);
  await db.subscription.deleteMany({
    where: { userId: ctx.userId, subjectType: s.type, subjectId: s.id, workspaceId: ctx.workspaceId },
  });
  return s;
}

/**
 * Subscribe `userIds` (author, assignee, commenter, mentioned) to an item.
 * Only current members are added; existing rows are kept. Never throws.
 */
export async function autoSubscribe(
  ctx: TenantContext,
  subject: SubscriptionSubject,
  userIds: string[],
): Promise<void> {
  try {
    const wanted = [...new Set(userIds)].filter((id) => id.length > 0 && id.length <= 64).slice(0, MAX_SUBSCRIBERS);
    if (wanted.length === 0) return;
    const members = await db.membership.findMany({
      where: { workspaceId: ctx.workspaceId, userId: { in: wanted } },
      select: { userId: true },
    });
    if (members.length === 0) return;
    await db.subscription.createMany({
      data: members.map((m) => ({
        workspaceId: ctx.workspaceId,
        userId: m.userId,
        subjectType: subject.type,
        subjectId: subject.id,
      })),
      skipDuplicates: true,
    });
  } catch (e) {
    console.error("[subscriptions] autoSubscribe failed:", e);
  }
}

/**
 * For an item that has no subscribers yet (created before subscriptions
 * existed): subscribe `legacyIds` (its owners and earlier commenters) once, so
 * such items keep notifying the people they used to. Never throws.
 */
export async function ensureSubscribers(
  ctx: TenantContext,
  subject: SubscriptionSubject,
  legacyIds: string[],
): Promise<void> {
  try {
    const any = await db.subscription.findFirst({
      where: { workspaceId: ctx.workspaceId, subjectType: subject.type, subjectId: subject.id },
      select: { id: true },
    });
    if (!any) await autoSubscribe(ctx, subject, legacyIds);
  } catch (e) {
    console.error("[subscriptions] ensureSubscribers failed:", e);
  }
}
