import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { tokenizeLinks as tokenizeText } from "@/lib/linkify";
import { ServiceError } from "@/server/errors";
import {
  createComment,
  createPost,
  deleteComment,
  deletePost,
  getPost,
  listPosts,
  setPostPinned,
  updateComment,
  updatePost,
} from "@/server/messages";

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

describe("messages service", () => {
  let owner: TenantContext;
  let admin: TenantContext;
  let alice: TenantContext;
  let bob: TenantContext;
  let otherOwner: TenantContext;
  let wsB: string;

  beforeAll(async () => {
    const ownerUser = await createTestUser();
    const a = await createTestWorkspace(ownerUser.id);
    owner = a.ctx;
    admin = (await createMember(owner.workspaceId, "ADMIN")).ctx;
    alice = (await createMember(owner.workspaceId, "MEMBER")).ctx;
    bob = (await createMember(owner.workspaceId, "MEMBER")).ctx;

    const otherUser = await createTestUser();
    const b = await createTestWorkspace(otherUser.id);
    otherOwner = b.ctx;
    wsB = b.workspace.id;
  });

  it("creates a post with author and workspace taken from ctx", async () => {
    const post = await createPost(alice, {
      title: "  Merhaba  ",
      body: "Ilk mesaj",
      workspaceId: "evil",
      authorId: "evil",
    });
    expect(post.title).toBe("Merhaba");
    expect(post.workspaceId).toBe(alice.workspaceId);
    expect(post.authorId).toBe(alice.userId);
  });

  it("validates input", async () => {
    expect(await code(createPost(alice, { title: "", body: "x" }))).toBe("VALIDATION");
    expect(await code(createPost(alice, { title: "x", body: "   " }))).toBe("VALIDATION");
    const post = await createPost(alice, { title: "v", body: "v" });
    expect(await code(createComment(alice, post.id, { body: "" }))).toBe("VALIDATION");
  });

  it("list excerpts strip markdown before clipping (long code block, long link url)", async () => {
    const t = await createTestUser();
    const { ctx } = await createTestWorkspace(t.id);
    const code = "```js\n" + Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join("\n");
    await createPost(ctx, { title: "kod", body: `${code}\n\`\`\`\nAsıl açıklama burada.` });
    await createPost(ctx, { title: "link", body: `Detay: [rapor](https://ornek.com/${"a".repeat(300)})` });
    const { items } = await listPosts(ctx);
    const byTitle = Object.fromEntries(items.map((p) => [p.title, p.excerpt]));
    expect(byTitle.kod).toBe("Asıl açıklama burada.");
    expect(byTitle.link).toBe("Detay: rapor");
    for (const excerpt of Object.values(byTitle)) {
      expect(excerpt).not.toContain("```");
      expect(excerpt).not.toContain("](");
    }
  });

  it("lists pinned first, then newest, with comment counts and pagination", async () => {
    const t = await createTestUser();
    const { ctx } = await createTestWorkspace(t.id);
    const p1 = await createPost(ctx, { title: "one", body: "1" });
    const p2 = await createPost(ctx, { title: "two", body: "2" });
    const p3 = await createPost(ctx, { title: "three", body: "3" });
    await db.post.update({ where: { id: p1.id }, data: { createdAt: new Date(Date.now() - 3000) } });
    await db.post.update({ where: { id: p2.id }, data: { createdAt: new Date(Date.now() - 2000) } });
    await db.post.update({ where: { id: p3.id }, data: { createdAt: new Date(Date.now() - 1000) } });
    await createComment(ctx, p1.id, { body: "c1" });
    await createComment(ctx, p1.id, { body: "c2" });

    let res = await listPosts(ctx);
    expect(res.items.map((p) => p.id)).toEqual([p3.id, p2.id, p1.id]);
    expect(res.items[2].commentCount).toBe(2);

    await setPostPinned(ctx, p1.id, true);
    res = await listPosts(ctx);
    expect(res.items.map((p) => p.id)).toEqual([p1.id, p3.id, p2.id]);

    const page1 = await listPosts(ctx, { take: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    const page2 = await listPosts(ctx, { take: 2, cursor: page1.nextCursor });
    expect(page2.items.map((p) => p.id)).toEqual([p2.id]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it("returns comments oldest first", async () => {
    const post = await createPost(alice, { title: "thread", body: "t" });
    const c1 = await createComment(alice, post.id, { body: "first" });
    const c2 = await createComment(bob, post.id, { body: "second" });
    await db.comment.update({ where: { id: c1.id }, data: { createdAt: new Date(Date.now() - 5000) } });
    const full = await getPost(owner, post.id);
    expect(full.comments.map((c) => c.id)).toEqual([c1.id, c2.id]);
  });

  describe("permissions", () => {
    it("member cannot edit or delete another member's post; author can", async () => {
      const post = await createPost(alice, { title: "alice", body: "a" });
      expect(await code(updatePost(bob, post.id, { title: "hack", body: "x" }))).toBe("FORBIDDEN");
      expect(await code(deletePost(bob, post.id))).toBe("FORBIDDEN");
      expect(await code(updatePost(alice, post.id, { title: "mine", body: "x" }))).toBe("OK");
      expect((await getPost(alice, post.id)).title).toBe("mine");
      expect(await code(deletePost(alice, post.id))).toBe("OK");
    });

    it("admin and owner can edit and delete anyone's post", async () => {
      const p1 = await createPost(alice, { title: "p1", body: "a" });
      const p2 = await createPost(alice, { title: "p2", body: "a" });
      expect(await code(updatePost(admin, p1.id, { title: "edited", body: "b" }))).toBe("OK");
      expect(await code(deletePost(admin, p1.id))).toBe("OK");
      expect(await code(deletePost(owner, p2.id))).toBe("OK");
    });

    it("member cannot edit or delete another member's comment; admin can", async () => {
      const post = await createPost(alice, { title: "c", body: "c" });
      const c = await createComment(alice, post.id, { body: "hello" });
      expect(await code(updateComment(bob, c.id, { body: "x" }))).toBe("FORBIDDEN");
      expect(await code(deleteComment(bob, c.id))).toBe("FORBIDDEN");
      expect(await code(updateComment(alice, c.id, { body: "mine" }))).toBe("OK");
      expect(await code(updateComment(admin, c.id, { body: "admin edit" }))).toBe("OK");
      expect(await code(deleteComment(admin, c.id))).toBe("OK");
    });

    it("only admin/owner can pin", async () => {
      const post = await createPost(alice, { title: "pin", body: "p" });
      expect(await code(setPostPinned(alice, post.id, true))).toBe("FORBIDDEN");
      expect(await code(setPostPinned(admin, post.id, true))).toBe("OK");
      expect((await getPost(bob, post.id)).pinned).toBe(true);
      expect(await code(setPostPinned(owner, post.id, false))).toBe("OK");
    });

    it("pinning and unpinning do not mark the post as edited", async () => {
      const post = await createPost(alice, { title: "pin-edit", body: "p" });
      await new Promise((r) => setTimeout(r, 1100));
      await setPostPinned(admin, post.id, true);
      const pinned = await getPost(bob, post.id);
      expect(pinned.pinned).toBe(true);
      expect(pinned.updatedAt.getTime()).toBe(post.updatedAt.getTime());
      await setPostPinned(admin, post.id, false);
      expect((await getPost(bob, post.id)).updatedAt.getTime()).toBe(post.updatedAt.getTime());
    });
  });

  describe("tenant isolation", () => {
    it("workspace A cannot read, list, update, delete or pin workspace B rows", async () => {
      const bPost = await createPost(otherOwner, { title: "secret", body: "secret body" });
      const bComment = await createComment(otherOwner, bPost.id, { body: "secret comment" });

      expect(await code(getPost(owner, bPost.id))).toBe("NOT_FOUND");
      const list = await listPosts(owner, { take: 50 });
      expect(list.items.some((p) => p.id === bPost.id)).toBe(false);

      // Even the highest role in A gets nothing from B.
      expect(await code(updatePost(owner, bPost.id, { title: "x", body: "x" }))).toBe("NOT_FOUND");
      expect(await code(deletePost(owner, bPost.id))).toBe("NOT_FOUND");
      expect(await code(setPostPinned(owner, bPost.id, true))).toBe("NOT_FOUND");
      expect(await code(updateComment(owner, bComment.id, { body: "x" }))).toBe("NOT_FOUND");
      expect(await code(deleteComment(owner, bComment.id))).toBe("NOT_FOUND");

      const post = await db.post.findUniqueOrThrow({ where: { id: bPost.id } });
      expect(post.title).toBe("secret");
      expect(post.pinned).toBe(false);
      const comment = await db.comment.findUniqueOrThrow({ where: { id: bComment.id } });
      expect(comment.body).toBe("secret comment");
    });

    it("cannot attach a comment to another workspace's post", async () => {
      const bPost = await createPost(otherOwner, { title: "b", body: "b" });
      expect(await code(createComment(alice, bPost.id, { body: "intrude" }))).toBe("NOT_FOUND");
      expect(await db.comment.count({ where: { postId: bPost.id } })).toBe(0);
    });

    it("stored comment workspaceId always equals ctx.workspaceId", async () => {
      const post = await createPost(alice, { title: "w", body: "w" });
      const c = await createComment(alice, post.id, { body: "ok" });
      expect(c.workspaceId).toBe(alice.workspaceId);
      expect(c.workspaceId).not.toBe(wsB);
    });

    it("a forged ctx for B cannot see A's rows", async () => {
      const post = await createPost(alice, { title: "a only", body: "a" });
      expect(await code(getPost(otherOwner, post.id))).toBe("NOT_FOUND");
    });
  });
});

describe("rich text tokenizer", () => {
  it("links http(s) URLs and strips trailing punctuation", () => {
    const parts = tokenizeText("Bak: https://example.com/a?b=1, sonra http://x.org.");
    const links = parts.filter((p) => p.type === "link");
    expect(links.map((l) => l.value)).toEqual(["https://example.com/a?b=1", "http://x.org"]);
  });

  it("does not link javascript: or plain text, and keeps HTML as text", () => {
    const parts = tokenizeText("javascript:alert(1) <script>alert(1)</script>");
    expect(parts.every((p) => p.type === "text")).toBe(true);
    expect(parts.map((p) => p.value).join("")).toBe("javascript:alert(1) <script>alert(1)</script>");
  });
});

describe("listPosts cursor pagination", () => {
  let ctx: TenantContext;
  let other: TenantContext;

  beforeAll(async () => {
    const u = await createTestUser();
    const o = await createTestUser();
    ctx = (await createTestWorkspace(u.id)).ctx;
    other = (await createTestWorkspace(o.id)).ctx;
  });

  async function seed(n: number, createdAt: (i: number) => Date, c: TenantContext = ctx) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const p = await createPost(c, { title: `p${i}`, body: "b" });
      await db.post.update({ where: { id: p.id }, data: { createdAt: createdAt(i), updatedAt: p.updatedAt } });
      ids.push(p.id);
    }
    return ids;
  }

  async function drain(take: number, between?: (pageNo: number) => Promise<void>) {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const res = await listPosts(ctx, { take, cursor });
      seen.push(...res.items.map((p) => p.id));
      if (!res.hasMore) return seen;
      cursor = res.nextCursor;
      expect(cursor).not.toBeNull();
      if (between) await between(page);
    }
    throw new Error("pagination did not terminate");
  }

  it("pages through many posts sharing one createdAt without duplicates or skips", async () => {
    const same = new Date("2030-01-01T00:00:00.000Z");
    const ids = await seed(11, () => same);
    const seen = await drain(3);
    const mine = seen.filter((id) => ids.includes(id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(mine).toHaveLength(11);
    // id desc tie-breaker
    expect(mine).toEqual([...ids].sort().reverse());
  });

  it("continues across the pinned/unpinned boundary", async () => {
    const ids = await seed(6, (i) => new Date(Date.UTC(2031, 0, 1, 0, 0, i)));
    await setPostPinned(ctx, ids[0], true); // oldest, pinned -> first
    await setPostPinned(ctx, ids[1], true);
    const all = await listPosts(ctx, { take: 50 });
    const seen = await drain(2);
    expect(seen).toEqual(all.items.map((p) => p.id));
    expect(seen.slice(0, 2).sort()).toEqual([ids[0], ids[1]].sort());
  });

  it("has no duplicates or skips when posts are created between page loads", async () => {
    const before = (await listPosts(ctx, { take: 50 })).items.map((p) => p.id);
    const seen = await drain(4, async (page) => {
      await createPost(ctx, { title: `new${page}`, body: "b" });
    });
    expect(new Set(seen).size).toBe(seen.length);
    // every pre-existing post is seen exactly once; new posts may appear at most once (checked by the uniqueness assertion)
    expect(seen.filter((id) => before.includes(id))).toEqual(before);
  });

  it("has no duplicates or skips when an already-listed post gets pinned between loads", async () => {
    const before = (await listPosts(ctx, { take: 100 })).items.map((p) => p.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pinnedId: string | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await listPosts(ctx, { take: 5, cursor });
      seen.push(...res.items.map((p) => p.id));
      if (i === 0) {
        pinnedId = res.items[2].id; // already shown on page 1
        await setPostPinned(ctx, pinnedId, true);
      }
      if (!res.hasMore) break;
      cursor = res.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...before].filter((id) => seen.includes(id)).sort());
    expect(seen).toHaveLength(before.length);
    expect(pinnedId).not.toBeNull();
  });

  it("rejects malformed cursors with a VALIDATION error", async () => {
    const bad = [
      "not a cursor",
      "!!!",
      Buffer.from("not json").toString("base64url"),
      Buffer.from(JSON.stringify({ p: 2, t: "x", i: "y" })).toString("base64url"),
      Buffer.from(JSON.stringify({ p: 0, t: "garbage", i: "y" })).toString("base64url"),
      Buffer.from(JSON.stringify({ p: 0, t: new Date().toISOString() })).toString("base64url"),
      "A".repeat(600),
    ];
    for (const cursor of bad) {
      await expect(listPosts(ctx, { cursor })).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("never returns another workspace's posts, even with a crafted cursor", async () => {
    const [foreign] = await seed(1, () => new Date("2032-01-01T00:00:00.000Z"), other);
    const cursor = Buffer.from(
      JSON.stringify({ p: 0, t: "2033-01-01T00:00:00.000Z", i: "zzzz" }),
    ).toString("base64url");
    const res = await listPosts(ctx, { cursor, take: 50 });
    expect(res.items.map((p) => p.id)).not.toContain(foreign);
    const full = await listPosts(ctx, { take: 50 });
    expect(full.items.map((p) => p.id)).not.toContain(foreign);
  });
});
