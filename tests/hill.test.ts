import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { hillPoint } from "@/lib/hill-curve";
import { getHillHistory, hillPhase, setHillPosition } from "@/server/hill";
import { createTodoList, deleteTodoList, listTodoLists } from "@/server/todos";

import { cleanup, createMember, createTestUser, createTestWorkspace, disconnect } from "./helpers";

let ctxA: TenantContext;
let ctxB: TenantContext;
let memberA: TenantContext;

beforeAll(async () => {
  const ownerA = await createTestUser();
  const ownerB = await createTestUser();
  ctxA = (await createTestWorkspace(ownerA.id)).ctx;
  ctxB = (await createTestWorkspace(ownerB.id)).ctx;
  memberA = (await createMember(ctxA.workspaceId, "MEMBER")).ctx;
});

afterAll(async () => {
  await cleanup();
  await disconnect();
});

describe("hill charts", () => {
  it("defaults to 0 and lets any member update with a note", async () => {
    const list = await createTodoList(ctxA, { name: "Tepe" });
    const before = (await listTodoLists(ctxA)).find((l) => l.id === list.id);
    expect(before).toMatchObject({ hillPosition: 0, hillNote: null });

    await setHillPosition(memberA, list.id, 62, "  Artık uyguluyoruz  ");
    const after = (await listTodoLists(ctxA)).find((l) => l.id === list.id);
    expect(after).toMatchObject({ hillPosition: 62, hillNote: "Artık uyguluyoruz" });
  });

  it("stores snapshots newest first and records activity", async () => {
    const list = await createTodoList(ctxA, { name: "Geçmiş" });
    await setHillPosition(ctxA, list.id, 20);
    await new Promise((r) => setTimeout(r, 5));
    await setHillPosition(memberA, list.id, 70, "ilerledi");
    const history = await getHillHistory(ctxA, list.id);
    expect(history.map((h) => h.position)).toEqual([70, 20]);
    expect(history[0].note).toBe("ilerledi");
    expect(history[0].createdById).toBe(memberA.userId);
    const acts = await db.activity.count({
      where: { workspaceId: ctxA.workspaceId, type: "HILL_UPDATED", subjectId: list.id },
    });
    expect(acts).toBe(2);
  });

  it("validates position range and note length", async () => {
    const list = await createTodoList(ctxA, { name: "Doğrulama" });
    for (const bad of [-1, 101, 5.5, "abc"]) {
      await expect(setHillPosition(ctxA, list.id, bad)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(setHillPosition(ctxA, list.id, 10, "x".repeat(501))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await setHillPosition(ctxA, list.id, 100);
    await setHillPosition(ctxA, list.id, 0);
    expect(await db.hillSnapshot.count({ where: { listId: list.id } })).toBe(2);
  });

  it("is workspace scoped and rejects trashed lists", async () => {
    const list = await createTodoList(ctxA, { name: "İzole" });
    await expect(setHillPosition(ctxB, list.id, 30)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getHillHistory(ctxB, list.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await deleteTodoList(ctxA, list.id);
    await expect(setHillPosition(ctxA, list.id, 30)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getHillHistory(ctxA, list.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("maps positions to phases and curve points", () => {
    expect(hillPhase(50)).toBe("uphill");
    expect(hillPhase(51)).toBe("downhill");
    expect(hillPoint(0).y).toBeCloseTo(hillPoint(100).y);
    expect(hillPoint(50).y).toBeLessThan(hillPoint(25).y);
    expect(hillPoint(150).x).toBe(hillPoint(100).x);
  });
});
