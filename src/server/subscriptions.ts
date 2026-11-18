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

export type MySubscription = {
  type: SubscriptionSubjectType;
  id: string;
  title: string;
  subscribedAt: Date;
};

/**
 * Items the caller follows in this workspace, newest subscription first.
 * Subjects are polymorphic (no FK), so each one is re-loaded workspace-scoped
 * and trashed, hidden-draft or vanished subjects are dropped.
 */
export async function listMySubscriptions(ctx: TenantContext, opts: { take?: number } = {}): Promise<MySubscription[]> {
  const take = Math.min(Math.max(opts.take ?? 20, 1), 50);
  const subs = await db.subscription.findMany({
    where: { workspaceId: ctx.workspaceId, userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const idsOf = (t: SubscriptionSubjectType) => subs.filter((s) => s.subjectType === t).map((s) => s.subjectId);
  const base = { workspaceId: ctx.workspaceId, deletedAt: null };
  const [posts, todos, events] = await Promise.all([
    db.post.findMany({
      where: { ...base, id: { in: idsOf("post") }, ...visiblePostWhere(ctx) },
      select: { id: true, title: true },
    }),
    db.todoItem.findMany({
      where: { ...base, id: { in: idsOf("todo") }, list: { workspaceId: ctx.workspaceId, deletedAt: null } },
      select: { id: true, title: true },
    }),
    db.event.findMany({ where: { ...base, id: { in: idsOf("event") } }, select: { id: true, title: true } }),
  ]);
  const titles: Record<SubscriptionSubjectType, Map<string, string>> = {
    post: new Map(posts.map((p) => [p.id, p.title])),
    todo: new Map(todos.map((t) => [t.id, t.title])),
    event: new Map(events.map((e) => [e.id, e.title])),
  };
  const out: MySubscription[] = [];
  for (const s of subs) {
    const type = s.subjectType as SubscriptionSubjectType;
    const title = titles[type]?.get(s.subjectId);
    if (title === undefined) continue;
    out.push({ type, id: s.subjectId, title, subscribedAt: s.createdAt });
    if (out.length >= take) break;
  }
  return out;
}
