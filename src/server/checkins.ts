import { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { istanbulDayKey, toIstanbulParts } from "@/lib/istanbul-time";
import { hasRole } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { assertNotGuest } from "@/server/client-visibility";
import { conflict, forbidden, notFound, parseInput } from "@/server/errors";
import { notify } from "@/server/notifications";

/**
 * Automatic check-ins ("Otomatik kontroller"): recurring questions that are
 * posted to the workspace on a schedule (Istanbul weekday + hour). A scheduled
 * run creates one CheckinRound per question per Istanbul day; members answer
 * once per round (editable).
 */

export const MAX_QUESTIONS = 30;
export const CHECKIN_TEXT_MAX = 300;
export const ANSWER_MAX = 5000;
const ROUNDS_LIMIT = 30;
const ANSWERS_PER_ROUND = 200;

const questionSchema = z.object({
  text: z
    .string({ error: "Soru gerekli." })
    .trim()
    .min(1, "Soru gerekli.")
    .max(CHECKIN_TEXT_MAX, `Soru en fazla ${CHECKIN_TEXT_MAX} karakter olabilir.`),
  weekdays: z
    .array(z.number({ error: "Geçersiz gün." }).int("Geçersiz gün.").min(0, "Geçersiz gün.").max(6, "Geçersiz gün."), {
      error: "Geçersiz gün.",
    })
    .min(1, "En az bir gün seçin.")
    .max(7, "Geçersiz gün.")
    .transform((d) => [...new Set(d)].sort((a, b) => a - b)),
  hour: z
    .number({ error: "Geçersiz saat." })
    .int("Geçersiz saat.")
    .min(0, "Geçersiz saat.")
    .max(23, "Geçersiz saat."),
});

const answerSchema = z
  .string({ error: "Cevap gerekli." })
  .trim()
  .min(1, "Cevap gerekli.")
  .max(ANSWER_MAX, `Cevap en fazla ${ANSWER_MAX} karakter olabilir.`);

function requireAdmin(ctx: TenantContext) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden("Soruları yalnızca yöneticiler düzenleyebilir.");
}

export async function createQuestion(ctx: TenantContext, input: unknown) {
  assertNotGuest(ctx, "Check-in yalnızca ekibe açıktır.");
  requireAdmin(ctx);
  const data = parseInput(questionSchema, input);
  const count = await db.checkinQuestion.count({ where: { workspaceId: ctx.workspaceId } });
  if (count >= MAX_QUESTIONS) throw conflict(`En fazla ${MAX_QUESTIONS} soru oluşturabilirsiniz.`);
  return db.checkinQuestion.create({
    data: { ...data, workspaceId: ctx.workspaceId, createdById: ctx.userId },
  });
}

export async function updateQuestion(ctx: TenantContext, questionId: string, input: unknown) {
  assertNotGuest(ctx, "Check-in yalnızca ekibe açıktır.");
  requireAdmin(ctx);
  const data = parseInput(questionSchema, input);
  const res = await db.checkinQuestion.updateMany({
    where: { id: questionId, workspaceId: ctx.workspaceId },
    data,
  });
  if (res.count === 0) throw notFound("Soru bulunamadı.");
}

export async function setActive(ctx: TenantContext, questionId: string, active: unknown) {
  assertNotGuest(ctx, "Check-in yalnızca ekibe açıktır.");
  requireAdmin(ctx);
  const value = parseInput(z.boolean({ error: "Geçersiz değer." }), active);
  const res = await db.checkinQuestion.updateMany({
    where: { id: questionId, workspaceId: ctx.workspaceId },
    data: { active: value },
  });
  if (res.count === 0) throw notFound("Soru bulunamadı.");
}

/** Weekday (0 = Sunday) of an Istanbul calendar day key. */
function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Create today's round for every active question (all workspaces) whose
 * Istanbul weekday and hour match `now`, and notify the workspace's members.
 * Idempotent per (question, Istanbul day) via the unique index. Returns the
 * number of rounds created.
 */
export async function runDueCheckins(now: Date): Promise<number> {
  const dateKey = istanbulDayKey(now);
  const weekday = weekdayOfKey(dateKey);
  const hour = toIstanbulParts(now).hour;
  const questions = await db.checkinQuestion.findMany({
    where: { active: true, weekdays: { has: weekday }, hour },
    orderBy: { createdAt: "asc" },
  });
  let created = 0;
  for (const q of questions) {
    try {
      await db.checkinRound.create({ data: { workspaceId: q.workspaceId, questionId: q.id, dateKey } });
    } catch (e) {
      // Already created today (idempotent): skip quietly.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
      // One question's failure must not abort the whole run: other questions,
      // in other workspaces, still get their round this hour.
      console.error("[checkins] runDueCheckins: round create failed:", e instanceof Error ? e.message : e);
      continue;
    }
    created++;
    await notifyRound(q);
  }
  return created;
}

async function notifyRound(q: { workspaceId: string; text: string; createdById: string }) {
  const members = await db.membership.findMany({
    // Check-ins are team-only: guests are never asked.
    where: { workspaceId: q.workspaceId, role: { not: "GUEST" } },
    select: { userId: true, role: true },
  });
  if (members.length === 0) return;
  const input = {
    type: "CHECKIN" as const,
    title: `Otomatik kontrol: ${q.text.replace(/\s+/g, " ").trim().slice(0, 150)}`,
    body: null,
    path: "checkins",
  };
  // notify() never targets its actor, so the first actor's own notification
  // goes through a second call acting as another member.
  const actor = members.find((m) => m.userId === q.createdById) ?? members[0];
  const ids = members.map((m) => m.userId);
  await notify({ userId: actor.userId, workspaceId: q.workspaceId, role: actor.role }, { ...input, recipientIds: ids });
  const other = members.find((m) => m.userId !== actor.userId);
  if (other) {
    await notify(
      { userId: other.userId, workspaceId: q.workspaceId, role: other.role },
      { ...input, recipientIds: [actor.userId] },
    );
  }
}

/** Upsert the caller's answer; the round must belong to ctx's workspace. */
export async function answerCheckin(ctx: TenantContext, roundId: string, body: unknown) {
  assertNotGuest(ctx, "Check-in yalnızca ekibe açıktır.");
  const text = parseInput(answerSchema, body);
  const round = await db.checkinRound.findFirst({
    where: { id: roundId, workspaceId: ctx.workspaceId },
    select: { id: true },
  });
  if (!round) throw notFound("Kontrol bulunamadı.");
  return db.checkinAnswer.upsert({
    where: { roundId_userId: { roundId: round.id, userId: ctx.userId } },
    create: { workspaceId: ctx.workspaceId, roundId: round.id, userId: ctx.userId, body: text },
    update: { body: text },
  });
}

export type CheckinQuestionDto = {
  id: string;
  text: string;
  weekdays: number[];
  hour: number;
  active: boolean;
};
export type CheckinAnswerDto = {
  id: string;
  userId: string;
  authorName: string;
  body: string;
  updatedAt: Date;
};
export type CheckinRoundDto = {
  id: string;
  dateKey: string;
  questionId: string;
  questionText: string;
  answers: CheckinAnswerDto[];
};

/** All questions of the workspace + recent rounds (newest first, bounded) with their answers. */
export async function listCheckins(
  ctx: TenantContext,
): Promise<{ questions: CheckinQuestionDto[]; rounds: CheckinRoundDto[] }> {
  assertNotGuest(ctx, "Check-in yalnızca ekibe açıktır.");
  const [questions, rounds] = await Promise.all([
    db.checkinQuestion.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_QUESTIONS,
      select: { id: true, text: true, weekdays: true, hour: true, active: true },
    }),
    db.checkinRound.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ dateKey: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: ROUNDS_LIMIT,
      include: {
        question: { select: { text: true } },
        answers: {
          orderBy: { createdAt: "asc" },
          take: ANSWERS_PER_ROUND,
          include: { user: { select: { name: true, email: true } } },
        },
      },
    }),
  ]);
  return {
    questions,
    rounds: rounds.map((r) => ({
      id: r.id,
      dateKey: r.dateKey,
      questionId: r.questionId,
      questionText: r.question.text,
      answers: r.answers.map((a) => ({
        id: a.id,
        userId: a.userId,
        authorName: a.user.name?.trim() || a.user.email,
        body: a.body,
        updatedAt: a.updatedAt,
      })),
    })),
  };
}
