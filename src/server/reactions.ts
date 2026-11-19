import { z } from "zod";

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { notFound, parseInput } from "@/server/errors";
import {
  assertNotGuest,
  commentClientWhere,
  documentClientWhere,
  isGuest,
  clientVisibleWhere,
} from "@/server/client-visibility";
import { visiblePostWhere } from "@/server/post-visibility";

/**
 * Boosts ("Tepkiler"): short emoji reactions on posts, comments, chat
 * messages, to-do items, documents and events.
 *
 * The subject is polymorphic (no FK), so every call first loads it scoped by
 * ctx.workspaceId (NOT_FOUND otherwise). The emoji must come from a small
 * allowed set. One member can add each emoji once per subject (unique index);
 * toggling adds or removes the caller's own reaction.
 */

export const REACTION_SUBJECT_TYPES = ["post", "comment", "chatMessage", "todoItem", "document", "event"] as const;
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

/** A chat message is visible to team members; a DM only to its two people. */
function chatMessageWhere(ctx: TenantContext): Prisma.ChatMessageWhereInput {
  return {
    workspaceId: ctx.workspaceId,
    OR: [{ recipientId: null }, { recipientId: ctx.userId }, { authorId: ctx.userId }],
  };
}

/** The ids (of `ids`) of this type that exist in the workspace and are visible to the caller. */
async function visibleSubjectIds(ctx: TenantContext, type: ReactionSubjectType, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const w = ctx.workspaceId;
  const pick = (rows: { id: string }[]) => rows.map((r) => r.id);
  const select = { id: true } as const;
  switch (type) {
    case "post":
      return pick(
        await db.post.findMany({
          where: { id: { in: ids }, workspaceId: w, deletedAt: null, ...visiblePostWhere(ctx) },
          select,
        }),
      );
    case "comment":
      return pick(await db.comment.findMany({ where: { id: { in: ids }, workspaceId: w, ...commentClientWhere(ctx) }, select }));
    case "chatMessage":
      // The chat is team-only: guests see nothing.
      if (isGuest(ctx.role)) return [];
      return pick(await db.chatMessage.findMany({ where: { id: { in: ids }, ...chatMessageWhere(ctx) }, select }));
    case "todoItem":
      return pick(
        await db.todoItem.findMany({
          where: {
            id: { in: ids },
            workspaceId: w,
            deletedAt: null,
            list: { deletedAt: null, ...clientVisibleWhere(ctx) },
          },
          select,
        }),
      );
    case "document":
      return pick(
        await db.document.findMany({
          where: { id: { in: ids }, workspaceId: w, deletedAt: null, ...documentClientWhere(ctx) },
          select,
        }),
      );
    case "event":
      return pick(
        await db.event.findMany({
          where: { id: { in: ids }, workspaceId: w, deletedAt: null, ...clientVisibleWhere(ctx) },
          select,
        }),
      );
  }
}

async function requireSubject(ctx: TenantContext, input: unknown): Promise<ReactionSubject> {
  const s = parseInput(subjectSchema, input);
  if (s.type === "chatMessage") assertNotGuest(ctx, "Sohbet yalnızca ekibe açıktır.");
  const visible = await visibleSubjectIds(ctx, s.type, [s.id]);
  if (visible.length === 0) throw notFound("Kayıt bulunamadı.");
  return s;
}

/**
 * Removes every reaction on the given subjects. Call it inside the same
 * transaction that deletes them.
 */
export async function deleteReactionsFor(
  client: Pick<typeof db, "reaction">,
  workspaceId: string,
  type: ReactionSubjectType,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await client.reaction.deleteMany({ where: { workspaceId, subjectType: type, subjectId: { in: ids } } });
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
  const visible = await visibleSubjectIds(ctx, type, wanted);
  if (visible.length === 0) return result;
  const rows = await db.reaction.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      subjectType: type,
      subjectId: { in: visible },
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
