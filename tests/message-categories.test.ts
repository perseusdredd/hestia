import { afterAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  createCategory,
  deleteCategory,
  listCategories,
  moveCategory,
  updateCategory,
} from "@/server/message-categories";
import { createPost } from "@/server/messages";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

afterAll(async () => {
  await cleanup();
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? "ERR";
  }
  return "OK";
}

async function setup() {
  const owner = await createTestUser();
  const { workspace, ctx } = await createTestWorkspace(owner.id);
  const { ctx: member } = await createMember(workspace.id, "MEMBER");
  return { workspace, ctx, member };
}

describe("message category management", () => {
  it("admin creates, renames and deletes categories", async () => {
    const { ctx } = await setup();
    const c = await createCategory(ctx, { name: "Test", emoji: "🧪" });
    await updateCategory(ctx, c.id, { name: "Yeni ad", emoji: "🚀" });
    const [row] = await listCategories(ctx);
    expect(row).toMatchObject({ name: "Yeni ad", emoji: "🚀" });
    await deleteCategory(ctx, c.id);
    expect(await listCategories(ctx)).toHaveLength(0);
  });

  it("rejects a MEMBER on every mutation", async () => {
    const { ctx, member } = await setup();
    const c = await createCategory(ctx, { name: "A", emoji: "1" });
    expect(await code(createCategory(member, { name: "B", emoji: "2" }))).toBe("FORBIDDEN");
    expect(await code(updateCategory(member, c.id, { name: "X", emoji: "2" }))).toBe("FORBIDDEN");
    expect(await code(moveCategory(member, c.id, "down"))).toBe("FORBIDDEN");
    expect(await code(deleteCategory(member, c.id))).toBe("FORBIDDEN");
    expect(await listCategories(ctx)).toHaveLength(1);
  });

  it("reorders and keeps positions dense, also after delete", async () => {
    const { ctx } = await setup();
    const a = await createCategory(ctx, { name: "A", emoji: "1" });
    const b = await createCategory(ctx, { name: "B", emoji: "2" });
    const c = await createCategory(ctx, { name: "C", emoji: "3" });
    await moveCategory(ctx, c.id, "up");
    let list = await listCategories(ctx);
    expect(list.map((x) => x.name)).toEqual(["A", "C", "B"]);
    expect(list.map((x) => x.position)).toEqual([0, 1, 2]);
    // Edge moves are no-ops.
    await moveCategory(ctx, a.id, "up");
    await moveCategory(ctx, b.id, "down");
    list = await listCategories(ctx);
    expect(list.map((x) => x.name)).toEqual(["A", "C", "B"]);
    await deleteCategory(ctx, a.id);
    list = await listCategories(ctx);
    expect(list.map((x) => x.position)).toEqual([0, 1]);
    expect(await code(moveCategory(ctx, b.id, "sideways"))).toBe("VALIDATION");
  });

  it("rejects a category from another workspace", async () => {
    const one = await setup();
    const two = await setup();
    const foreign = await createCategory(two.ctx, { name: "Yabancı", emoji: "🌍" });
    expect(await code(updateCategory(one.ctx, foreign.id, { name: "x", emoji: "y" }))).toBe("NOT_FOUND");
    expect(await code(moveCategory(one.ctx, foreign.id, "up"))).toBe("NOT_FOUND");
    expect(await code(deleteCategory(one.ctx, foreign.id))).toBe("NOT_FOUND");
    expect(await listCategories(two.ctx)).toHaveLength(1);
  });

  it("keeps posts when their category is deleted", async () => {
    const { ctx } = await setup();
    const cat = await createCategory(ctx, { name: "Sil", emoji: "🗑️" });
    const post = await createPost(ctx, { title: "Merhaba", body: "içerik", categoryId: cat.id });
    await deleteCategory(ctx, cat.id);
    const row = await db.post.findUnique({ where: { id: post.id } });
    expect(row).not.toBeNull();
    expect(row?.categoryId).toBeNull();
  });
});
