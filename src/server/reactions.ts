import { z } from "zod";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { notFound, parseInput } from "@/server/errors";
import { visiblePostWhere } from "@/server/post-visibility";

/**
 * Boosts ("Tepkiler"): short emoji reactions on posts and comments.
 *
 * The subject is polymorphic (no FK), so every call first loads it scoped by
 * ctx.workspaceId (NOT_FOUND otherwise). The emoji must come from a small
 * allowed set. One member can add each emoji once per subject (unique index);
 * toggling adds or removes the caller's own reaction.
 */

export const REACTION_SUBJECT_TYPES = ["post", "comment"] as const;
export type ReactionSubjectType = (typeof REACTION_SUBJECT_TYPES)[number];
export type ReactionSubject = { type: ReactionSubjectType; id: string };

export const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👀", "🙏"] as const;

const MAX_REACTIONS_LOADED = 5000;
const MAX_IDS = 500;

const subjectSchema = z.object({
  type: z.enum(REACTION_SUBJECT_TYPES, { error: "Geçersiz tepki konusu." }),
  id: z.string({ error: "Kayıt bulunamadı." }).min(1, "Kayıt bulunamadı.").max(64, "Kayıt bulunamadı."),
});

const emojiSchema = z.enum(REACTION_EMOJIS, { error: "Geçersiz tepki." });

export type ReactionSummary = {
  emoji: string;
  count: number;
  /** The caller has reacted with this emoji. */
  mine: boolean;
};

async function requireSubject(ctx: TenantContext, input: unknown): Promise<ReactionSubject> {
  const s = parseInput(subjectSchema, input);
  let found: { id: string } | null = null;
  if (s.type === "post") {
    found = await db.post.findFirst({
      where: { id: s.id, workspaceId: ctx.workspaceId, deletedAt: null, ...visiblePostWhere(ctx) },
      select: { id: true },
    });
  } else {
    found = await db.comment.findFirst({
      where: { id: s.id, workspaceId: ctx.workspaceId },
      select: { id: true },
    });
  }
  if (!found) throw notFound("Kayıt bulunamadı.");
  return s;
}

/**
 * Add the caller's reaction, or remove it when it already exists. Returns the
 * subject and whether the reaction is now on.
 */
export async function toggleReaction(
  ctx: TenantContext,
  subject: unknown,
  emoji: unknown,
): Promise<{ subject: ReactionSubject; active: boolean }> {
  const s = await requireSubject(ctx, subject);
  const e = parseInput(emojiSchema, emoji);
  const where = {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    subjectType: s.type,
    subjectId: s.id,
    emoji: e,
  };
  const removed = await db.reaction.deleteMany({ where });
  if (removed.count > 0) return { subject: s, active: false };
  await db.reaction.createMany({ data: [where], skipDuplicates: true });
  return { subject: s, active: true };
}

/**
 * Grouped reaction counts for several subjects of one type, in allowed-emoji
 * order. Ids from other workspaces simply have no reactions. Only current
 * members' reactions count.
 */
export async function listReactions(
  ctx: TenantContext,
  type: ReactionSubjectType,
  ids: string[],
): Promise<Record<string, ReactionSummary[]>> {
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 64))].slice(
    0,
    MAX_IDS,
  );
  const result: Record<string, ReactionSummary[]> = {};
  if (wanted.length === 0) return result;
  const rows = await db.reaction.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      subjectType: type,
      subjectId: { in: wanted },
      user: { memberships: { some: { workspaceId: ctx.workspaceId } } },
    },
    select: { subjectId: true, userId: true, emoji: true },
    take: MAX_REACTIONS_LOADED,
  });
  const grouped = new Map<string, Map<string, ReactionSummary>>();
  for (const r of rows) {
    let bySubject = grouped.get(r.subjectId);
    if (!bySubject) grouped.set(r.subjectId, (bySubject = new Map()));
    const entry = bySubject.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
    entry.count += 1;
    if (r.userId === ctx.userId) entry.mine = true;
    bySubject.set(r.emoji, entry);
  }
  for (const [subjectId, byEmoji] of grouped) {
    result[subjectId] = REACTION_EMOJIS.flatMap((emoji) => {
      const entry = byEmoji.get(emoji);
      return entry ? [entry] : [];
    });
  }
  return result;
}
