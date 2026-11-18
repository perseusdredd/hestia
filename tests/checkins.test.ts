import { afterAll, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  answerCheckin,
  createQuestion,
  listCheckins,
  runDueCheckins,
  setActive,
  updateQuestion,
} from "@/server/checkins";
import { setMutedTypes } from "@/server/notification-preferences";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

afterAll(async () => {
  await cleanup();
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? "OTHER";
  }
  return "OK";
}

// 2026-11-18 is a Wednesday (weekday 3). 06:30Z = 09:30 in Istanbul (UTC+3).
const WED_9 = new Date("2026-11-18T06:30:00Z");
const WED_9_LATER = new Date("2026-11-18T06:59:00Z");
const WED_10 = new Date("2026-11-18T07:00:00Z");
const THU_9 = new Date("2026-11-19T06:30:00Z");
// 22:00Z on Tuesday is already 01:00 on Wednesday in Istanbul.
const TUE_2200Z = new Date("2026-11-17T22:00:00Z");

async function setup() {
  const owner = await createTestUser();
  const { workspace, ctx } = await createTestWorkspace(owner.id);
  const { ctx: member } = await createMember(workspace.id, "MEMBER");
  const q = await createQuestion(ctx, { text: "Bu hafta ne yapıyorsunuz?", weekdays: [3], hour: 9 });
  return { workspace, admin: ctx, member, q };
}

const roundsOf = (questionId: string) => db.checkinRound.findMany({ where: { questionId } });

describe("runDueCheckins", () => {
  it("creates a round on a matching Istanbul weekday + hour and notifies members", async () => {
    const { admin, member, q } = await setup();
    const n = await runDueCheckins(WED_9);
    expect(n).toBeGreaterThanOrEqual(1);
    const rounds = await roundsOf(q.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].dateKey).toBe("2026-11-18");
    const notes = await db.notification.findMany({
      where: { workspaceId: admin.workspaceId, type: "CHECKIN" },
    });
    expect(notes.map((x) => x.userId).sort()).toEqual([admin.userId, member.userId].sort());
    expect(notes[0].title).toBe("Otomatik kontrol: Bu hafta ne yapıyorsunuz?");
    expect(notes[0].path).toBe("checkins");
  });

  it("isolates a failing question so the rest of the run still gets their round", async () => {
    // 11:00Z Wed = 14:00 Istanbul (weekday 3); hour 14 is used by no other test,
    // so only these two questions are due at this instant.
    const WED_14 = new Date("2026-11-18T11:00:00Z");
    const a = (await createTestWorkspace((await createTestUser()).id)).ctx;
    const b = (await createTestWorkspace((await createTestUser()).id)).ctx;
    const qa = await createQuestion(a, { text: "A sorusu", weekdays: [3], hour: 14 });
    const qb = await createQuestion(b, { text: "B sorusu", weekdays: [3], hour: 14 });

    // The first round create (qa, created earliest) throws a non-P2002 error.
    const spy = vi.spyOn(db.checkinRound, "create").mockRejectedValueOnce(new Error("boom"));
    await expect(runDueCheckins(WED_14)).resolves.toBeGreaterThanOrEqual(1);
    spy.mockRestore();

    expect(await roundsOf(qa.id)).toHaveLength(0); // failed, skipped
    expect(await roundsOf(qb.id)).toHaveLength(1); // still created
  });

  it("does not duplicate a round on a second run in the same hour", async () => {
    const { q } = await setup();
    await runDueCheckins(WED_9);
    await runDueCheckins(WED_9_LATER);
    expect(await roundsOf(q.id)).toHaveLength(1);
    const notified = await db.notification.count({ where: { workspaceId: q.workspaceId, type: "CHECKIN" } });
    expect(notified).toBe(2);
  });

  it("creates nothing on a non-matching hour or weekday", async () => {
    const { q } = await setup();
    await runDueCheckins(WED_10);
    await runDueCheckins(THU_9);
    expect(await roundsOf(q.id)).toHaveLength(0);
  });

  it("uses Istanbul local time, not UTC, for weekday and hour", async () => {
    const { admin } = await setup();
    // Tuesday 22:00Z == Wednesday 01:00 Istanbul: a 01:00 Wednesday question fires.
    const late = await createQuestion(admin, { text: "Gece", weekdays: [3], hour: 1 });
    await runDueCheckins(TUE_2200Z);
    const rounds = await roundsOf(late.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].dateKey).toBe("2026-11-18");
  });

  it("skips inactive questions", async () => {
    const { admin, q } = await setup();
    await setActive(admin, q.id, false);
    await runDueCheckins(WED_9);
    expect(await roundsOf(q.id)).toHaveLength(0);
  });

  it("respects NotificationPreference mutes", async () => {
    const { admin, member, q } = await setup();
    await setMutedTypes(member, ["CHECKIN"]);
    await runDueCheckins(WED_9);
    expect(await roundsOf(q.id)).toHaveLength(1);
    const notes = await db.notification.findMany({
      where: { workspaceId: admin.workspaceId, type: "CHECKIN" },
    });
    expect(notes.map((x) => x.userId)).toEqual([admin.userId]);
  });
});

describe("answerCheckin / listCheckins", () => {
  it("upserts the caller's answer and lists it with the author name", async () => {
    const { admin, member, q } = await setup();
    await runDueCheckins(WED_9);
    const [round] = await roundsOf(q.id);
    await answerCheckin(member, round.id, "İlk cevap");
    await answerCheckin(member, round.id, "  Düzenlenmiş cevap  ");
    await answerCheckin(admin, round.id, "Yönetici cevabı");
    expect(await db.checkinAnswer.count({ where: { roundId: round.id } })).toBe(2);
    const { rounds, questions } = await listCheckins(member);
    expect(questions.map((x) => x.id)).toContain(q.id);
    const r = rounds.find((x) => x.id === round.id)!;
    expect(r.questionText).toBe("Bu hafta ne yapıyorsunuz?");
    expect(r.answers).toHaveLength(2);
    const mine = r.answers.find((a) => a.userId === member.userId)!;
    expect(mine.body).toBe("Düzenlenmiş cevap");
    expect(mine.authorName.length).toBeGreaterThan(0);
  });

  it("rejects empty answers", async () => {
    const { member, q } = await setup();
    await runDueCheckins(WED_9);
    const [round] = await roundsOf(q.id);
    expect(await code(answerCheckin(member, round.id, "   "))).toBe("VALIDATION");
  });

  it("rejects a round from another workspace", async () => {
    const { q } = await setup();
    await runDueCheckins(WED_9);
    const [round] = await roundsOf(q.id);
    const otherOwner = await createTestUser();
    const { ctx: other } = await createTestWorkspace(otherOwner.id);
    expect(await code(answerCheckin(other, round.id, "Sızıntı"))).toBe("NOT_FOUND");
    expect(await db.checkinAnswer.count({ where: { roundId: round.id } })).toBe(0);
    const { rounds } = await listCheckins(other);
    expect(rounds).toHaveLength(0);
  });
});

describe("question management", () => {
  it("is admin-only", async () => {
    const { member, q } = await setup();
    expect(await code(createQuestion(member, { text: "x", weekdays: [1], hour: 9 }))).toBe("FORBIDDEN");
    expect(await code(updateQuestion(member, q.id, { text: "x", weekdays: [1], hour: 9 }))).toBe("FORBIDDEN");
    expect(await code(setActive(member, q.id, false))).toBe("FORBIDDEN");
  });

  it("validates weekdays, hour and text", async () => {
    const { admin } = await setup();
    const ok = { text: "Soru", weekdays: [1], hour: 9 };
    expect(await code(createQuestion(admin, { ...ok, weekdays: [7] }))).toBe("VALIDATION");
    expect(await code(createQuestion(admin, { ...ok, weekdays: [-1] }))).toBe("VALIDATION");
    expect(await code(createQuestion(admin, { ...ok, weekdays: [] }))).toBe("VALIDATION");
    expect(await code(createQuestion(admin, { ...ok, hour: 24 }))).toBe("VALIDATION");
    expect(await code(createQuestion(admin, { ...ok, hour: 1.5 }))).toBe("VALIDATION");
    expect(await code(createQuestion(admin, { ...ok, text: "  " }))).toBe("VALIDATION");
    expect(await code(createQuestion(admin, { ...ok, text: "a".repeat(301) }))).toBe("VALIDATION");
    const made = await createQuestion(admin, { ...ok, weekdays: [5, 1, 5] });
    expect(made.weekdays).toEqual([1, 5]);
  });

  it("rejects editing a question of another workspace", async () => {
    const { q } = await setup();
    const otherOwner = await createTestUser();
    const { ctx: otherAdmin } = await createTestWorkspace(otherOwner.id);
    expect(await code(updateQuestion(otherAdmin, q.id, { text: "Ele geçir", weekdays: [1], hour: 9 }))).toBe(
      "NOT_FOUND",
    );
    expect(await code(setActive(otherAdmin, q.id, false))).toBe("NOT_FOUND");
    expect((await db.checkinQuestion.findUnique({ where: { id: q.id } }))!.active).toBe(true);
  });
});
