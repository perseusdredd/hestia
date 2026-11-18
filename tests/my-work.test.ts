import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { addDaysToKey, istanbulDayKey, parseIstanbulLocal } from "@/lib/istanbul-time";
import type { TenantContext } from "@/lib/tenant-context";
import { getMyWork, groupMyTodos } from "@/server/my-work";
import { listMySubscriptions } from "@/server/subscriptions";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

let owner: TenantContext;
let member: TenantContext;
let other: TenantContext;

const NOW = parseIstanbulLocal("2026-11-11T12:00") as Date;
const TODAY = istanbulDayKey(NOW);
const day = (n: number) => new Date(`${addDaysToKey(TODAY, n)}T00:00:00.000Z`);

beforeAll(async () => {
  const u = await createTestUser();
  ({ ctx: owner } = await createTestWorkspace(u.id));
  ({ ctx: member } = await createMember(owner.workspaceId, "MEMBER"));
  const ub = await createTestUser();
  ({ ctx: other } = await createTestWorkspace(ub.id));
});

afterAll(async () => {
  await cleanup();
});

describe("groupMyTodos", () => {
  it("splits by due date", () => {
    const mk = (id: string, dueDate: string | null) => ({ id, dueDate }) as never;
    const g = groupMyTodos([mk("a", "2026-11-01"), mk("b", TODAY), mk("c", "2026-12-01"), mk("d", null)], TODAY);
    expect([g.overdue, g.today, g.upcoming, g.undated].map((x) => x.map((t) => t.id))).toEqual([
      ["a"],
      ["b"],
      ["c"],
      ["d"],
    ]);
  });
});

describe("getMyWork", () => {
  it("aggregates my items and hides trashed, foreign and others' drafts", async () => {
    const list = await db.todoList.create({
      data: { workspaceId: owner.workspaceId, createdById: owner.userId, name: "L" },
    });
    const mkTodo = (title: string, extra: Record<string, unknown> = {}) =>
      db.todoItem.create({
        data: {
          workspaceId: owner.workspaceId,
          listId: list.id,
          createdById: owner.userId,
          assigneeId: member.userId,
          title,
          ...extra,
        },
      });
    await mkTodo("gecikmiş", { dueDate: day(-1) });
    await mkTodo("bugün", { dueDate: day(0) });
    await mkTodo("gelecek", { dueDate: day(4) });
    await mkTodo("tarihsiz");
    await mkTodo("çöpte", { deletedAt: new Date() });
    const subTodo = await mkTodo("takip edilen", { assigneeId: null });

    const mkPost = (authorId: string, title: string, extra: Record<string, unknown> = {}) =>
      db.post.create({
        data: { workspaceId: owner.workspaceId, authorId, title, body: "x", publishedAt: null, ...extra },
      });
    const myDraft = await mkPost(member.userId, "benim taslak");
    await mkPost(owner.userId, "başkasının taslağı");
    await mkPost(member.userId, "çöpteki taslak", { deletedAt: new Date() });
    const hiddenDraft = await mkPost(owner.userId, "gizli taslak");
    const trashedSub = await mkPost(owner.userId, "silinen", { publishedAt: new Date(), deletedAt: new Date() });

    const ev = await db.event.create({
      data: {
        workspaceId: owner.workspaceId,
        createdById: owner.userId,
        title: "yakın",
        startsAt: new Date(NOW.getTime() + 5 * 86400000),
        endsAt: new Date(NOW.getTime() + 5 * 86400000 + 3600000),
      },
    });
    await db.event.create({
      data: {
        workspaceId: owner.workspaceId,
        createdById: owner.userId,
        title: "uzak",
        startsAt: new Date(NOW.getTime() + 60 * 86400000),
        endsAt: new Date(NOW.getTime() + 60 * 86400000 + 3600000),
      },
    });

    for (const [subjectType, subjectId] of [
      ["todo", subTodo.id],
      ["event", ev.id],
      ["post", trashedSub.id],
      ["post", hiddenDraft.id],
    ] as const) {
      await db.subscription.create({
        data: { workspaceId: owner.workspaceId, userId: member.userId, subjectType, subjectId },
      });
    }

    const work = await getMyWork(member, { today: TODAY, now: NOW });
    expect(work.todos.overdue.map((t) => t.title)).toEqual(["gecikmiş"]);
    expect(work.todos.today.map((t) => t.title)).toEqual(["bugün"]);
    expect(work.todos.upcoming.map((t) => t.title)).toEqual(["gelecek"]);
    expect(work.todos.undated.map((t) => t.title)).toEqual(["tarihsiz"]);
    expect(work.todoTotal).toBe(4);
    expect(work.events.map((e) => e.title)).toEqual(["yakın"]);
    expect(work.drafts.map((d) => d.id)).toEqual([myDraft.id]);
    expect(work.subscriptions.map((s) => `${s.type}:${s.title}`).sort()).toEqual(["event:yakın", "todo:takip edilen"]);

    // Trashing a subscribed item removes it.
    await db.event.update({ where: { id: ev.id }, data: { deletedAt: new Date() } });
    expect((await listMySubscriptions(member)).map((s) => s.title)).toEqual(["takip edilen"]);

    // Nothing leaks across workspaces.
    const empty = await getMyWork(other, { today: TODAY, now: NOW });
    expect(empty.todoTotal).toBe(0);
    expect(empty.events).toEqual([]);
    expect(empty.drafts).toEqual([]);
    expect(empty.subscriptions).toEqual([]);
  });
});
