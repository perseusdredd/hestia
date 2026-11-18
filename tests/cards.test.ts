import { afterAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  createCard,
  createColumn,
  deleteCard,
  deleteColumn,
  ensureDefaultColumns,
  listBoard,
  moveCard,
  moveColumn,
  renameColumn,
  updateCard,
} from "@/server/cards";
import { createWorkspace } from "@/server/workspaces";

import { cleanup, createMember, createTestUser, createTestWorkspace, trackWorkspace, uniqueSuffix } from "./helpers";

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

async function setup() {
  const owner = await createTestUser();
  const { workspace, ctx } = await createTestWorkspace(owner.id);
  const { user: memberUser, ctx: member } = await createMember(workspace.id, "MEMBER");
  const board = await listBoard(ctx);
  return { workspace, admin: ctx, member, memberUser, board };
}

const positions = (xs: { position: number }[]) => xs.map((x) => x.position);

describe("default columns", () => {
  it("seeds Triyaj / Yapılıyor / Bitti lazily and idempotently", async () => {
    const { admin, board } = await setup();
    expect(board.map((c) => c.name)).toEqual(["Triyaj", "Yapılıyor", "Bitti"]);
    expect(positions(board)).toEqual([0, 1, 2]);
    await ensureDefaultColumns(db, admin.workspaceId, admin.userId);
    await listBoard(admin);
    expect(await db.cardColumn.count({ where: { workspaceId: admin.workspaceId } })).toBe(3);
  });

  it("is seeded by createWorkspace", async () => {
    const user = await createTestUser();
    const ws = await createWorkspace({ userId: user.id }, { name: "Pano Alanı", slug: `pano-${uniqueSuffix()}` });
    trackWorkspace(ws.id);
    const cols = await db.cardColumn.findMany({ where: { workspaceId: ws.id }, orderBy: { position: "asc" } });
    expect(cols.map((c) => c.name)).toEqual(["Triyaj", "Yapılıyor", "Bitti"]);
  });
});

describe("columns", () => {
  it("creates, renames, reorders and deletes with dense positions", async () => {
    const { admin, board } = await setup();
    const extra = await createColumn(admin, { name: "İnceleme" });
    expect(extra.position).toBe(3);
    await renameColumn(admin, extra.id, { name: "Gözden geçirme" });
    await moveColumn(admin, extra.id, "up");
    let cols = await listBoard(admin);
    expect(cols.map((c) => c.name)).toEqual(["Triyaj", "Yapılıyor", "Gözden geçirme", "Bitti"]);
    expect(positions(cols)).toEqual([0, 1, 2, 3]);
    await deleteColumn(admin, board[0].id);
    cols = await listBoard(admin);
    expect(cols.map((c) => c.name)).toEqual(["Yapılıyor", "Gözden geçirme", "Bitti"]);
    expect(positions(cols)).toEqual([0, 1, 2]);
  });

  it("requires ADMIN and refuses to delete a column that has cards", async () => {
    const { admin, member, board } = await setup();
    expect(await code(createColumn(member, { name: "X" }))).toBe("FORBIDDEN");
    expect(await code(renameColumn(member, board[0].id, { name: "X" }))).toBe("FORBIDDEN");
    expect(await code(moveColumn(member, board[0].id, "down"))).toBe("FORBIDDEN");
    expect(await code(deleteColumn(member, board[0].id))).toBe("FORBIDDEN");
    await createCard(member, board[0].id, { title: "Kart" });
    expect(await code(deleteColumn(admin, board[0].id))).toBe("CONFLICT");
    expect(await code(createColumn(admin, { name: "  " }))).toBe("VALIDATION");
  });
});

describe("cards", () => {
  it("creates, lists in order and updates a card", async () => {
    const { admin, member, memberUser, board } = await setup();
    const a = await createCard(admin, board[0].id, { title: "Birinci" });
    await createCard(member, board[0].id, { title: "İkinci", assigneeId: memberUser.id, dueOn: "2026-12-01" });
    await updateCard(admin, a.id, { title: "Birinci (düzenlendi)", notes: "not" });
    const col = (await listBoard(admin))[0];
    expect(col.cards.map((c) => c.title)).toEqual(["Birinci (düzenlendi)", "İkinci"]);
    expect(positions(col.cards)).toEqual([0, 1]);
    expect(col.cards[0].notes).toBe("not");
    expect(col.cards[1].assignee?.id).toBe(memberUser.id);
    expect(col.cards[1].dueOn).toBe("2026-12-01");
    await updateCard(admin, col.cards[1].id, { assigneeId: null, dueOn: "" });
    const again = (await listBoard(admin))[0].cards[1];
    expect(again.assigneeId).toBeNull();
    expect(again.dueOn).toBeNull();
  });

  it("validates input", async () => {
    const { admin, board } = await setup();
    expect(await code(createCard(admin, board[0].id, { title: " " }))).toBe("VALIDATION");
    expect(await code(createCard(admin, board[0].id, { title: "x", dueOn: "2026-13-45" }))).toBe("VALIDATION");
  });

  it("requires the assignee to be a workspace member", async () => {
    const { admin, board } = await setup();
    const outsider = await createTestUser();
    expect(await code(createCard(admin, board[0].id, { title: "x", assigneeId: outsider.id }))).toBe("VALIDATION");
    const c = await createCard(admin, board[0].id, { title: "y" });
    expect(await code(updateCard(admin, c.id, { assigneeId: outsider.id }))).toBe("VALIDATION");
  });

  it("moves across columns keeping both columns dense", async () => {
    const { admin, board } = await setup();
    const [triage, doing] = board;
    const a = await createCard(admin, triage.id, { title: "A" });
    const b = await createCard(admin, triage.id, { title: "B" });
    const c = await createCard(admin, triage.id, { title: "C" });
    const d = await createCard(admin, doing.id, { title: "D" });
    await moveCard(admin, b.id, { columnId: doing.id }); // to the end
    await moveCard(admin, c.id, { columnId: doing.id, position: 0 });
    let cols = await listBoard(admin);
    expect(cols[0].cards.map((x) => x.title)).toEqual(["A"]);
    expect(positions(cols[0].cards)).toEqual([0]);
    expect(cols[1].cards.map((x) => x.title)).toEqual(["C", "D", "B"]);
    expect(positions(cols[1].cards)).toEqual([0, 1, 2]);
    expect(cols[1].cards.every((x) => x.columnId === doing.id)).toBe(true);
    // within a column
    await moveCard(admin, b.id, { direction: "up" });
    await moveCard(admin, c.id, { direction: "up" }); // already first: no-op
    cols = await listBoard(admin);
    expect(cols[1].cards.map((x) => x.title)).toEqual(["C", "B", "D"]);
    expect(positions(cols[1].cards)).toEqual([0, 1, 2]);
    void a;
    void d;
  });

  it("rejects moves to a missing / foreign column and bad input", async () => {
    const { admin, board } = await setup();
    const other = await setup();
    const c = await createCard(admin, board[0].id, { title: "A" });
    expect(await code(moveCard(admin, c.id, { columnId: other.board[0].id }))).toBe("NOT_FOUND");
    expect(await code(moveCard(admin, c.id, {}))).toBe("VALIDATION");
    expect(await code(moveCard(admin, c.id, { direction: "up", columnId: board[1].id }))).toBe("VALIDATION");
  });

  it("soft-deletes: hidden from the board, positions closed up, rest untouched", async () => {
    const { admin, member, board } = await setup();
    const a = await createCard(admin, board[0].id, { title: "A" });
    const b = await createCard(admin, board[0].id, { title: "B" });
    await createCard(admin, board[0].id, { title: "C" });
    // another member may not delete someone else's card
    expect(await code(deleteCard(member, b.id))).toBe("FORBIDDEN");
    await deleteCard(admin, b.id);
    const col = (await listBoard(admin))[0];
    expect(col.cards.map((x) => x.title)).toEqual(["A", "C"]);
    expect(positions(col.cards)).toEqual([0, 1]);
    const row = await db.card.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedById).toBe(admin.userId);
    expect(await code(updateCard(admin, b.id, { title: "x" }))).toBe("NOT_FOUND");
    expect(await code(moveCard(admin, b.id, { direction: "down" }))).toBe("NOT_FOUND");
    expect(await code(deleteCard(admin, b.id))).toBe("NOT_FOUND");
    // a deleted card does not block deleting its column
    await deleteCard(admin, a.id);
    const rest = (await listBoard(admin))[0].cards;
    await Promise.all(rest.map((c) => deleteCard(admin, c.id)));
    expect(await code(deleteColumn(admin, board[0].id))).toBe("OK");
  });
});

describe("workspace isolation", () => {
  it("never reads or writes another workspace's board", async () => {
    const a = await setup();
    const b = await setup();
    const card = await createCard(a.admin, a.board[0].id, { title: "Gizli" });
    expect((await listBoard(b.admin)).flatMap((c) => c.cards)).toHaveLength(0);
    expect(await code(updateCard(b.admin, card.id, { title: "x" }))).toBe("NOT_FOUND");
    expect(await code(moveCard(b.admin, card.id, { direction: "down" }))).toBe("NOT_FOUND");
    expect(await code(deleteCard(b.admin, card.id))).toBe("NOT_FOUND");
    expect(await code(createCard(b.admin, a.board[0].id, { title: "x" }))).toBe("NOT_FOUND");
    expect(await code(renameColumn(b.admin, a.board[0].id, { name: "x" }))).toBe("NOT_FOUND");
    expect(await code(moveColumn(b.admin, a.board[0].id, "down"))).toBe("NOT_FOUND");
    expect(await code(deleteColumn(b.admin, a.board[0].id))).toBe("NOT_FOUND");
    expect((await listBoard(a.admin))[0].cards.map((c) => c.title)).toEqual(["Gizli"]);
  });
});
