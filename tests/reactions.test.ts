import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TenantContext } from "@/lib/tenant-context";
import { addComment, deleteComment } from "@/server/comments";
import { ServiceError } from "@/server/errors";
import { createPost } from "@/server/messages";
import { listReactions, toggleReaction } from "@/server/reactions";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

afterAll(async () => {
  await cleanup();
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e.code;
    throw e;
  }
  return "OK";
}

describe("reactions service", () => {
  let owner: TenantContext;
  let alice: TenantContext;
  let other: TenantContext;

  beforeAll(async () => {
    const u = await createTestUser({ name: "Sahip" });
    owner = (await createTestWorkspace(u.id)).ctx;
    alice = (await createMember(owner.workspaceId)).ctx;
    const o = await createTestUser();
    other = (await createTestWorkspace(o.id)).ctx;
  });

  it("toggles and groups reactions on a post", async () => {
    const post = await createPost(owner, { title: "Duyuru", body: "metin" });
    const subject = { type: "post", id: post.id };
    expect((await toggleReaction(owner, subject, "👍")).active).toBe(true);
    expect((await toggleReaction(alice, subject, "👍")).active).toBe(true);
    expect((await toggleReaction(alice, subject, "🎉")).active).toBe(true);

    const list = (await listReactions(alice, "post", [post.id]))[post.id];
    expect(list).toEqual([
      { emoji: "👍", count: 2, mine: true },
      { emoji: "🎉", count: 1, mine: true },
    ]);

    expect((await toggleReaction(alice, subject, "👍")).active).toBe(false);
    const after = (await listReactions(alice, "post", [post.id]))[post.id];
    expect(after[0]).toEqual({ emoji: "👍", count: 1, mine: false });
  });

  it("rejects unknown emoji and subjects of other workspaces", async () => {
    const post = await createPost(owner, { title: "Gizli", body: "metin" });
    expect(await code(toggleReaction(owner, { type: "post", id: post.id }, "💩x"))).toBe("VALIDATION");
    expect(await code(toggleReaction(other, { type: "post", id: post.id }, "👍"))).toBe("NOT_FOUND");
    expect(await code(toggleReaction(owner, { type: "todo", id: post.id }, "👍"))).toBe("VALIDATION");
    expect((await listReactions(other, "post", [post.id]))[post.id]).toBeUndefined();
  });

  it("reacts to comments and removes reactions with the comment", async () => {
    const post = await createPost(owner, { title: "Konu", body: "metin" });
    const comment = await addComment(owner, { type: "post", id: post.id }, { body: "Yorum" });
    await toggleReaction(alice, { type: "comment", id: comment.id }, "❤️");
    expect((await listReactions(owner, "comment", [comment.id]))[comment.id]).toEqual([
      { emoji: "❤️", count: 1, mine: false },
    ]);
    await deleteComment(owner, comment.id);
    expect((await listReactions(owner, "comment", [comment.id]))[comment.id]).toBeUndefined();
  });
});
