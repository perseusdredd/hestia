import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { addDaysToKey, istanbulDayKey, parseIstanbulLocal } from "@/lib/istanbul-time";
import type { TenantContext } from "@/lib/tenant-context";
import { listUpcomingEvents } from "@/server/calendar";
import { listRecentItems } from "@/server/files";
import { listMyOpenTodos } from "@/server/todos";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

/** Overview widgets: ordering, windows and tenant isolation of the summary queries. */

let owner: TenantContext;
let member: TenantContext;
let ownerB: TenantContext;

const NOW = parseIstanbulLocal("2026-11-11T12:00") as Date;
const TODAY = istanbulDayKey(NOW);

function at(local: string): Date {
  const d = parseIstanbulLocal(local);
  if (!d) throw new Error(local);
  return d;
}

beforeAll(async () => {
  const u = await createTestUser();
  ({ ctx: owner } = await createTestWorkspace(u.id));
  ({ ctx: member } = await createMember(owner.workspaceId, "MEMBER"));
  const ub = await createTestUser();
  ({ ctx: ownerB } = await createTestWorkspace(ub.id));
});

afterAll(async () => {
  await cleanup();
});

describe("listMyOpenTodos", () => {
  it("returns only my open items in this workspace, overdue first, undated last", async () => {
    const list = await db.todoList.create({
      data: { workspaceId: owner.workspaceId, createdById: owner.userId, name: "Lansman" },
    });
    const listB = await db.todoList.create({
      data: { workspaceId: ownerB.workspaceId, createdById: ownerB.userId, name: "B listesi" },
    });
    const mk = (title: string, extra: Record<string, unknown> = {}) =>
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
    await mk("tarihsiz");
    await mk("gelecek", { dueDate: new Date(`${addDaysToKey(TODAY, 3)}T00:00:00.000Z`) });
    await mk("gecikmiş", { dueDate: new Date(`${addDaysToKey(TODAY, -2)}T00:00:00.000Z`) });
    await mk("bitti", { status: "DONE", dueDate: new Date(`${addDaysToKey(TODAY, -5)}T00:00:00.000Z`) });
    await mk("başkasının", { assigneeId: owner.userId });
    // Same user id would never be assigned in B, but make sure B rows never leak.
    await db.todoItem.create({
      data: {
        workspaceId: ownerB.workspaceId,
        listId: listB.id,
        createdById: ownerB.userId,
        title: "B'nin işi",
        assigneeId: ownerB.userId,
      },
    });

    const { items, total } = await listMyOpenTodos(member, { today: TODAY });
    expect(items.map((i) => i.title)).toEqual(["gecikmiş", "gelecek", "tarihsiz"]);
    expect(total).toBe(3);
    expect(items.map((i) => i.overdue)).toEqual([true, false, false]);
    expect(items[0].listName).toBe("Lansman");

    const forB = await listMyOpenTodos(ownerB, { today: TODAY });
    expect(forB.items.map((i) => i.title)).toEqual(["B'nin işi"]);
  });

  it("rejects an invalid today value", async () => {
    await expect(listMyOpenTodos(member, { today: "2026-13-40" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("listUpcomingEvents", () => {
  it("includes running and next-14-day events, excludes past, far-future and other tenants", async () => {
    const ev = (workspaceId: string, createdById: string, title: string, s: string, e: string) =>
      db.event.create({ data: { workspaceId, createdById, title, startsAt: at(s), endsAt: at(e) } });
    await ev(owner.workspaceId, owner.userId, "geçmiş", "2026-11-10T09:00", "2026-11-10T10:00");
    await ev(owner.workspaceId, owner.userId, "sürüyor", "2026-11-11T11:00", "2026-11-11T13:00");
    await ev(owner.workspaceId, member.userId, "yarın", "2026-11-12T09:00", "2026-11-12T10:00");
    await ev(owner.workspaceId, owner.userId, "14. gün", "2026-11-25T20:00", "2026-11-25T21:00");
    await ev(owner.workspaceId, owner.userId, "çok ileride", "2026-11-26T09:00", "2026-11-26T10:00");
    await ev(ownerB.workspaceId, ownerB.userId, "B etkinliği", "2026-11-12T09:00", "2026-11-12T10:00");

    const events = await listUpcomingEvents(member, { days: 14, now: NOW });
    expect(events.map((e) => e.title)).toEqual(["sürüyor", "yarın", "14. gün"]);
    // canEdit follows the author-or-admin rule.
    expect(events.map((e) => e.canEdit)).toEqual([false, true, false]);
  });
});

describe("listRecentItems", () => {
  it("merges files and documents newest first, scoped to the workspace", async () => {
    const base = Date.now();
    await db.file.create({
      data: {
        workspaceId: owner.workspaceId,
        uploadedById: owner.userId,
        name: "eski.pdf",
        mimeType: "application/pdf",
        size: 10,
        storageKey: `${owner.workspaceId}/test-${base}-a`,
        createdAt: new Date(base - 60_000),
      },
    });
    await db.document.create({
      data: { workspaceId: owner.workspaceId, authorId: member.userId, title: "Toplantı notu", content: "x" },
    });
    await db.file.create({
      data: {
        workspaceId: ownerB.workspaceId,
        uploadedById: ownerB.userId,
        name: "b-gizli.pdf",
        mimeType: "application/pdf",
        size: 10,
        storageKey: `${ownerB.workspaceId}/test-${base}-b`,
      },
    });

    const items = await listRecentItems(member, { take: 5 });
    expect(items.map((i) => `${i.kind}:${i.name}`)).toEqual(["document:Toplantı notu", "file:eski.pdf"]);
    const forB = await listRecentItems(ownerB);
    expect(forB.map((i) => i.name)).toEqual(["b-gizli.pdf"]);
  });
});
