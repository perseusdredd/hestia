import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import {
  escapeLike,
  findMatches,
  makeSnippet,
  parseSearchTypes,
  queryVariants,
  searchWorkspace,
  type SearchResponse,
  type SearchType,
} from "@/server/search";

import { cleanup, createMember, createTestUser, createTestWorkspace, disconnect, uniqueSuffix } from "./helpers";

let ctxA: TenantContext;
let memberA: TenantContext;
let ctxB: TenantContext;
/** Unique token so other tests' rows in the shared dev DB never match. */
const TOKEN = `zq${uniqueSuffix()}`;

const ids: Record<"A" | "B", Partial<Record<SearchType, string>> & { listId?: string; postId?: string }> = {
  A: {},
  B: {},
};

async function seed(ctx: TenantContext, side: "A" | "B") {
  const ws = ctx.workspaceId;
  const by = ctx.userId;
  const folder = await db.folder.create({
    data: { workspaceId: ws, createdById: by, name: `Klasör ${TOKEN} ${side}` },
  });
  const post = await db.post.create({
    data: { workspaceId: ws, authorId: by, title: `Duyuru ${side}`, body: `Gövde içinde ${TOKEN} geçiyor ${side}` },
  });
  const comment = await db.comment.create({
    data: { workspaceId: ws, postId: post.id, authorId: by, body: `Yorumda ${TOKEN} var ${side}` },
  });
  const list = await db.todoList.create({
    data: { workspaceId: ws, createdById: by, name: `Liste ${TOKEN} ${side}` },
  });
  const todo = await db.todoItem.create({
    data: { workspaceId: ws, listId: list.id, createdById: by, title: `İş ${side}`, notes: `Not: ${TOKEN}` },
  });
  const doc = await db.document.create({
    data: { workspaceId: ws, authorId: by, folderId: folder.id, title: `Doküman ${side}`, content: `İçerik ${TOKEN}` },
  });
  const file = await db.file.create({
    data: {
      workspaceId: ws,
      uploadedById: by,
      folderId: folder.id,
      name: `rapor-${TOKEN}-${side}.pdf`,
      mimeType: "application/pdf",
      size: 1234,
      storageKey: `${ws}/${uniqueSuffix()}/rapor.pdf`,
    },
  });
  const event = await db.event.create({
    data: {
      workspaceId: ws,
      createdById: by,
      title: `Toplantı ${side}`,
      location: `Salon ${TOKEN}`,
      startsAt: new Date("2026-03-10T09:00:00Z"),
      endsAt: new Date("2026-03-10T10:00:00Z"),
    },
  });
  ids[side] = {
    post: post.id,
    comment: comment.id,
    list: list.id,
    todo: todo.id,
    document: doc.id,
    file: file.id,
    folder: folder.id,
    event: event.id,
    listId: list.id,
    postId: post.id,
  };
}

function allIds(res: SearchResponse): string[] {
  return res.groups.flatMap((g) => g.items.map((i) => i.id));
}

function group(res: SearchResponse, type: SearchType) {
  const g = res.groups.find((x) => x.type === type);
  if (!g) throw new Error(`missing group ${type}`);
  return g;
}

beforeAll(async () => {
  const ownerA = await createTestUser();
  const ownerB = await createTestUser();
  ctxA = (await createTestWorkspace(ownerA.id)).ctx;
  ctxB = (await createTestWorkspace(ownerB.id)).ctx;
  memberA = (await createMember(ctxA.workspaceId, "MEMBER")).ctx;
  await seed(ctxA, "A");
  await seed(ctxB, "B");
});

afterAll(async () => {
  await cleanup();
  await disconnect();
});

describe("searchWorkspace: every type is found", () => {
  it("returns one hit per type with paths, snippets and highlights", async () => {
    const res = await searchWorkspace(ctxA, { q: TOKEN });
    expect(res.groups.map((g) => g.type)).toEqual([
      "post",
      "comment",
      "todo",
      "list",
      "document",
      "file",
      "folder",
      "event",
    ]);
    for (const g of res.groups) {
      expect(g.items.map((i) => i.id), g.type).toEqual([ids.A[g.type]]);
      expect(g.hasMore).toBe(false);
    }
    expect(res.total).toBe(8);

    const post = group(res, "post").items[0];
    expect(post.path).toBe(`messages/${ids.A.post}`);
    expect(post.author?.id).toBe(ctxA.userId);
    expect(post.snippet?.text).toContain(TOKEN);
    const [s, e] = post.snippet!.ranges[0];
    expect(post.snippet!.text.slice(s, e)).toBe(TOKEN);

    expect(group(res, "comment").items[0].path).toBe(`messages/${ids.A.postId}`);
    expect(group(res, "comment").items[0].title.text).toBe("Duyuru A");
    expect(group(res, "todo").items[0].path).toBe("todos");
    expect(group(res, "todo").items[0].context).toBe(`Liste ${TOKEN} A`);
    expect(group(res, "document").items[0].path).toBe(`files/docs/${ids.A.document}`);
    const file = group(res, "file").items[0];
    expect(file.path).toBe(`files/${ids.A.folder}`);
    expect(file.file).toEqual({ id: ids.A.file, mimeType: "application/pdf", size: 1234 });
    expect(file.title.ranges.length).toBe(1);
    expect(group(res, "folder").items[0].path).toBe(`files/${ids.A.folder}`);
    const event = group(res, "event").items[0];
    expect(event.path).toBe("calendar?month=2026-03#agenda-2026-03-10");
    expect(event.snippet?.text).toBe(`Salon ${TOKEN}`);
  });

  it("matches post titles and event titles too", async () => {
    await db.post.create({
      data: { workspaceId: ctxA.workspaceId, authorId: ctxA.userId, title: `Başlıkta ${TOKEN}title`, body: "boş" },
    });
    const res = await searchWorkspace(ctxA, { q: `${TOKEN}title`, types: ["post"] });
    expect(group(res, "post").items).toHaveLength(1);
    expect(group(res, "post").items[0].title.ranges).toEqual([[9, 9 + TOKEN.length + 5]]);
  });

  it("filters by types", async () => {
    const res = await searchWorkspace(ctxA, { q: TOKEN, types: ["file", "event", "file"] });
    expect(res.groups.map((g) => g.type)).toEqual(["file", "event"]);
  });

  it("is case-insensitive, including Turkish letters", async () => {
    const tag = `t${uniqueSuffix()}`;
    await db.post.create({
      data: {
        workspaceId: ctxA.workspaceId,
        authorId: ctxA.userId,
        title: `IŞIK ${tag}`,
        body: `ÇAĞRI ÖZÜ İSTANBUL ${tag}`,
      },
    });
    for (const q of [`ışık ${tag}`, `IŞIK ${tag}`, `çağrı özü istanbul ${tag}`, `İstanbul ${tag}`]) {
      const res = await searchWorkspace(ctxA, { q, types: ["post"] });
      expect(group(res, "post").items, q).toHaveLength(1);
    }
    expect(queryVariants("ışık")).toContain("işik");
    expect(findMatches("IŞIK geldi", "ışık")).toEqual([[0, 4]]);
  });

  it("finds dotless-ı text for uppercase-I queries (IŞIK, Işık)", async () => {
    // No i/I in the tag so every variant keeps it intact.
    const tag = `t${uniqueSuffix()}`.replace(/i/g, "x");
    await db.post.create({
      data: { workspaceId: ctxA.workspaceId, authorId: ctxA.userId, title: `ışık ${tag} testi`, body: "gövde" },
    });
    for (const q of [`IŞIK ${tag}`, `Işık ${tag}`, `ışık ${tag}`]) {
      const res = await searchWorkspace(ctxA, { q, types: ["post"] });
      expect(group(res, "post").items, q).toHaveLength(1);
    }
    // ILIKE folds the remaining letters; only the I family needs explicit variants.
    expect(queryVariants("IŞIK")).toContain("ıŞıK");
    expect(queryVariants("Işık")).toContain("ışık");
  });
});

describe("searchWorkspace: tenant isolation", () => {
  it("never returns another workspace's rows even when the text matches", async () => {
    const resA = await searchWorkspace(ctxA, { q: TOKEN, limitPerType: 50 });
    const resB = await searchWorkspace(ctxB, { q: TOKEN, limitPerType: 50 });
    const bIds = Object.values(ids.B);
    const aIds = Object.values(ids.A);
    for (const id of allIds(resA)) expect(bIds).not.toContain(id);
    for (const id of allIds(resB)) expect(aIds).not.toContain(id);
    expect(allIds(resB).sort()).toEqual(
      (["post", "comment", "todo", "list", "document", "file", "folder", "event"] as const)
        .map((t) => ids.B[t]!)
        .sort(),
    );
  });

  it("does not find a workspace-B row by its exact unique text from workspace A", async () => {
    const res = await searchWorkspace(ctxA, { q: `rapor-${TOKEN}-B` });
    expect(res.total).toBe(0);
  });

  it("ignores a forged ctx for a workspace without matching rows", async () => {
    const outsider = await createTestUser();
    const { ctx } = await createTestWorkspace(outsider.id);
    const res = await searchWorkspace(ctx, { q: TOKEN });
    expect(res.total).toBe(0);
  });
});

describe("searchWorkspace: permissions", () => {
  it("a MEMBER finds content written by others in the workspace", async () => {
    const res = await searchWorkspace(memberA, { q: TOKEN });
    for (const g of res.groups) expect(g.items.map((i) => i.id), g.type).toContain(ids.A[g.type]);
    expect(group(res, "post").items[0].author?.id).toBe(ctxA.userId);
  });
});

describe("searchWorkspace: LIKE wildcards are literal", () => {
  const w = `w${uniqueSuffix()}`;
  beforeAll(async () => {
    const make = (title: string) =>
      db.post.create({ data: { workspaceId: ctxA.workspaceId, authorId: ctxA.userId, title, body: "-" } });
    await make(`${w} 50% indirim`);
    await make(`${w} 50 indirim`);
    await make(`${w} a_b`);
    await make(`${w} axb`);
    await make(`${w} c\\d`);
    await make(`${w} cd`);
  });

  const titles = async (q: string) =>
    group(await searchWorkspace(ctxA, { q, types: ["post"] }), "post").items.map((i) => i.title.text);

  it("treats % literally", async () => {
    expect(await titles(`${w} 50%`)).toEqual([`${w} 50% indirim`]);
    expect(await titles("%%")).not.toContain(`${w} 50 indirim`);
  });

  it("treats _ literally", async () => {
    expect(await titles(`${w} a_b`)).toEqual([`${w} a_b`]);
    expect(await titles("__")).not.toContain(`${w} axb`);
  });

  it("documents that raw Prisma contains does NOT escape wildcards (why escapeLike exists)", async () => {
    const raw = await db.post.findMany({
      where: { workspaceId: ctxA.workspaceId, title: { contains: `${w} a_b`.replace("a_b", "a_"), mode: "insensitive" } },
      select: { title: true },
    });
    expect(raw.map((r) => r.title).sort()).toEqual([`${w} a_b`, `${w} axb`]);
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });

  it("treats backslash literally", async () => {
    expect(await titles(`${w} c\\d`)).toEqual([`${w} c\\d`]);
    expect(await titles(`${w} c\\`)).toEqual([`${w} c\\d`]);
  });
});

describe("searchWorkspace: validation and limits", () => {
  it("rejects queries shorter than 2 or longer than 100 characters", async () => {
    await expect(searchWorkspace(ctxA, { q: "a" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(searchWorkspace(ctxA, { q: "   a   " })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(searchWorkspace(ctxA, { q: "x".repeat(101) })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(searchWorkspace(ctxA, { q: "x".repeat(100) })).resolves.toBeTruthy();
    await expect(searchWorkspace(ctxA, { q: "ab" })).resolves.toBeTruthy();
  });

  it("rejects unknown types and out-of-range limits", async () => {
    await expect(
      searchWorkspace(ctxA, { q: TOKEN, types: ["user" as SearchType] }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(searchWorkspace(ctxA, { q: TOKEN, limitPerType: 0 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(searchWorkspace(ctxA, { q: TOKEN, limitPerType: 51 })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("caps results per type and reports hasMore", async () => {
    const tag = `cap${uniqueSuffix()}`;
    for (let i = 0; i < 4; i += 1) {
      await db.folder.create({
        data: { workspaceId: ctxA.workspaceId, createdById: ctxA.userId, name: `${tag} ${i}` },
      });
    }
    const capped = group(await searchWorkspace(ctxA, { q: tag, types: ["folder"], limitPerType: 3 }), "folder");
    expect(capped.items).toHaveLength(3);
    expect(capped.hasMore).toBe(true);
    const exact = group(await searchWorkspace(ctxA, { q: tag, types: ["folder"], limitPerType: 4 }), "folder");
    expect(exact.items).toHaveLength(4);
    expect(exact.hasMore).toBe(false);
  });
});

describe("snippet and type helpers", () => {
  it("cuts a short excerpt around a late match", () => {
    const text = `${"lorem ipsum ".repeat(40)}hedef kelime ${"dolor ".repeat(40)}`;
    const s = makeSnippet(text, "hedef")!;
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.text.endsWith("…")).toBe(true);
    expect(s.text.length).toBeLessThan(220);
    const [a, b] = s.ranges[0];
    expect(s.text.slice(a, b)).toBe("hedef");
  });

  it("returns null for empty text and the start when nothing matches", () => {
    expect(makeSnippet(null, "x")).toBeNull();
    expect(makeSnippet("  \n ", "x")).toBeNull();
    expect(makeSnippet("kısa metin", "yok")).toEqual({ text: "kısa metin", ranges: [] });
  });

  it("parses type params and drops unknown values", () => {
    expect(parseSearchTypes(undefined)).toEqual([]);
    expect(parseSearchTypes("post,file,bogus")).toEqual(["post", "file"]);
    expect(parseSearchTypes(["event", "event"])).toEqual(["event"]);
  });
});
