import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dropDeleted, groupFeed, mergeMessages, type FeedItem } from "@/components/chat/chat-utils";
import { db } from "@/lib/db";
import { tokenizeLinks } from "@/lib/linkify";
import { parseWorkspaceChannel, workspaceChannel } from "@/lib/pusher/channels";
import { CHAT_MAX_BODY, compareCursor, decodeCursor, encodeCursor } from "@/lib/pusher/chat-protocol";
import type { TenantContext } from "@/lib/tenant-context";
import {
  assertChatRateLimit,
  authorizeChatChannel,
  CHAT_RATE_LIMIT,
  CHAT_RATE_WINDOW_MS,
  createMessage,
  createMessageIdempotent,
  deleteMessage,
  getMessage,
  listLiveIdsFrom,
  listMessages,
  listMessagesAfter,
  sendChatMessage,
} from "@/server/chat";
import { ServiceError } from "@/server/errors";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e.code;
    throw e;
  }
  return "OK";
}

let owner: TenantContext;
let admin: TenantContext;
let alice: TenantContext;
let bob: TenantContext;
let ownerB: TenantContext;

beforeAll(async () => {
  const u1 = await createTestUser();
  ({ ctx: owner } = await createTestWorkspace(u1.id));
  ({ ctx: admin } = await createMember(owner.workspaceId, "ADMIN"));
  ({ ctx: alice } = await createMember(owner.workspaceId, "MEMBER"));
  ({ ctx: bob } = await createMember(owner.workspaceId, "MEMBER"));
  const u2 = await createTestUser();
  ({ ctx: ownerB } = await createTestWorkspace(u2.id));
});

afterAll(async () => {
  await cleanup();
});

describe("chat service: rate limit", () => {
  it("blocks a user after CHAT_RATE_LIMIT messages in the window, per user and per workspace", async () => {
    const { ctx: carol } = await createMember(owner.workspaceId, "MEMBER");
    expect(await code(assertChatRateLimit(carol))).toBe("OK");
    await db.chatMessage.createMany({
      data: Array.from({ length: CHAT_RATE_LIMIT }, (_, i) => ({
        workspaceId: carol.workspaceId,
        authorId: carol.userId,
        body: `flood ${i}`,
      })),
    });
    expect(await code(assertChatRateLimit(carol))).toBe("CONFLICT");
    // Other users are unaffected, and the window expires.
    expect(await code(assertChatRateLimit(bob))).toBe("OK");
    const later = new Date(Date.now() + CHAT_RATE_WINDOW_MS + 1000);
    expect(await code(assertChatRateLimit(carol, later))).toBe("OK");
  });
});

describe("chat service: create + validation", () => {
  it("trims the body and stores it in the caller's workspace", async () => {
    const m = await createMessage(alice, { body: "  Merhaba ekip  " });
    expect(m.body).toBe("Merhaba ekip");
    expect(m.authorId).toBe(alice.userId);
    const row = await db.chatMessage.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.workspaceId).toBe(owner.workspaceId);
  });

  it("rejects empty, whitespace-only, non-string and over-long bodies", async () => {
    expect(await code(createMessage(alice, { body: "" }))).toBe("VALIDATION");
    expect(await code(createMessage(alice, { body: "   \n\t " }))).toBe("VALIDATION");
    expect(await code(createMessage(alice, { body: 42 }))).toBe("VALIDATION");
    expect(await code(createMessage(alice, { body: "a".repeat(CHAT_MAX_BODY + 1) }))).toBe("VALIDATION");
    expect(await code(createMessage(alice, { body: "a".repeat(CHAT_MAX_BODY) }))).toBe("OK");
  });

  it("rejects a forged ctx for a workspace the user is not a member of", async () => {
    const forged: TenantContext = { userId: alice.userId, workspaceId: ownerB.workspaceId, role: "OWNER" };
    expect(await code(createMessage(forged, { body: "sızma" }))).toBe("NOT_FOUND");
    expect(await db.chatMessage.count({ where: { workspaceId: ownerB.workspaceId, authorId: alice.userId } })).toBe(0);
  });
});

describe("chat service: idempotent send (clientId)", () => {
  let n = 0;
  const cid = () => `test-client-${Date.now().toString(36)}-${++n}`;

  it("a retry with the same clientId returns the stored message without a second row", async () => {
    const clientId = cid();
    const first = await sendChatMessage(alice, { body: "  tekrar denenecek  ", clientId });
    expect(first.created).toBe(true);
    const retry = await sendChatMessage(alice, { body: "tekrar denenecek", clientId });
    expect(retry.created).toBe(false);
    expect(retry.message).toEqual(first.message);
    expect(await db.chatMessage.count({ where: { workspaceId: alice.workspaceId, authorId: alice.userId, clientId } })).toBe(1);
    const row = await db.chatMessage.findUniqueOrThrow({ where: { id: first.message.id } });
    expect(row.clientId).toBe(clientId);
    // createMessage honours the same key.
    expect((await createMessage(alice, { body: "tekrar denenecek", clientId })).id).toBe(first.message.id);
  });

  it("fetched rows carry clientId for their author only, so a lost send response can be reconciled", async () => {
    const clientId = cid();
    const sent = await sendChatMessage(alice, { body: "yanıt kayboldu", clientId });
    expect(sent.message.clientId).toBe(clientId);
    const mine = (await listMessages(alice)).messages.find((m) => m.id === sent.message.id);
    expect(mine?.clientId).toBe(clientId);
    expect((await getMessage(alice, sent.message.id)).clientId).toBe(clientId);
    // Other members (and admins) never see someone else's send id.
    const theirs = (await listMessages(bob)).messages.find((m) => m.id === sent.message.id);
    expect(theirs).toBeTruthy();
    expect(theirs).not.toHaveProperty("clientId");
    expect(await getMessage(admin, sent.message.id)).not.toHaveProperty("clientId");
  });

  it("a parallel double-send stores exactly one message and reports one creation", async () => {
    const clientId = cid();
    const results = await Promise.all([
      sendChatMessage(bob, { body: "çift gönderim", clientId }),
      sendChatMessage(bob, { body: "çift gönderim", clientId }),
      sendChatMessage(bob, { body: "çift gönderim", clientId }),
    ]);
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await db.chatMessage.count({ where: { workspaceId: bob.workspaceId, clientId } })).toBe(1);
  });

  it("handles the unique-constraint race when no lock serialises the inserts", async () => {
    const clientId = cid();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => createMessageIdempotent(bob, { body: "yarış", clientId })),
    );
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await db.chatMessage.count({ where: { workspaceId: bob.workspaceId, clientId } })).toBe(1);
  });

  it("a retry does not consume the rate limit a second time", async () => {
    const { ctx: dana } = await createMember(owner.workspaceId, "MEMBER");
    await db.chatMessage.createMany({
      data: Array.from({ length: CHAT_RATE_LIMIT - 1 }, (_, i) => ({
        workspaceId: dana.workspaceId,
        authorId: dana.userId,
        body: `dolgu ${i}`,
      })),
    });
    const clientId = cid();
    const sent = await sendChatMessage(dana, { body: "son hak", clientId });
    expect(sent.created).toBe(true);
    // At the limit now: a retry of the same send still succeeds, a new send does not.
    const retry = await sendChatMessage(dana, { body: "son hak", clientId });
    expect(retry).toEqual({ message: sent.message, created: false });
    expect(await code(sendChatMessage(dana, { body: "yeni", clientId: cid() }))).toBe("CONFLICT");
    expect(await db.chatMessage.count({ where: { workspaceId: dana.workspaceId, authorId: dana.userId } })).toBe(
      CHAT_RATE_LIMIT,
    );
  });

  it("validates clientId shape and length", async () => {
    for (const bad of ["short", "a".repeat(65), "has space 123", "ünicode-1234", "a/b/c/d/e/f", "x;drop--", 12345678, null]) {
      expect(await code(sendChatMessage(alice, { body: "geçersiz kimlik", clientId: bad }))).toBe("VALIDATION");
      expect(await code(createMessage(alice, { body: "geçersiz kimlik", clientId: bad }))).toBe("VALIDATION");
    }
    expect(await code(sendChatMessage(alice, { body: "uuid", clientId: crypto.randomUUID() }))).toBe("OK");
    expect(await code(sendChatMessage(alice, { body: "uzun", clientId: "a".repeat(64) }))).toBe("OK");
    expect(await code(sendChatMessage(alice, { body: "anahtarsız" }))).toBe("OK");
  });

  it("refuses to reuse a clientId for a different body", async () => {
    const clientId = cid();
    const first = await sendChatMessage(alice, { body: "ilk metin", clientId });
    expect(await code(sendChatMessage(alice, { body: "başka metin", clientId }))).toBe("CONFLICT");
    expect(await code(createMessage(alice, { body: "başka metin", clientId }))).toBe("CONFLICT");
    expect((await getMessage(alice, first.message.id)).body).toBe("ilk metin");
  });

  it("the key is per author and per workspace: nobody gets another user's or tenant's message back", async () => {
    const clientId = cid();
    const a = await sendChatMessage(alice, { body: "aynı anahtar", clientId });
    const b = await sendChatMessage(bob, { body: "aynı anahtar", clientId });
    const other = await sendChatMessage(ownerB, { body: "aynı anahtar", clientId });
    expect(b.created).toBe(true);
    expect(other.created).toBe(true);
    expect(new Set([a.message.id, b.message.id, other.message.id]).size).toBe(3);
    expect((await db.chatMessage.findUniqueOrThrow({ where: { id: other.message.id } })).workspaceId).toBe(
      ownerB.workspaceId,
    );

    // A forged ctx pointing at B cannot read B's message through the key.
    const forged: TenantContext = { userId: ownerB.userId, workspaceId: owner.workspaceId, role: "OWNER" };
    expect(await code(sendChatMessage(forged, { body: "aynı anahtar", clientId }))).toBe("NOT_FOUND");
    expect(await code(createMessage(forged, { body: "aynı anahtar", clientId }))).toBe("NOT_FOUND");
    const forgedB: TenantContext = { userId: alice.userId, workspaceId: ownerB.workspaceId, role: "MEMBER" };
    expect(await code(sendChatMessage(forgedB, { body: "aynı anahtar", clientId }))).toBe("NOT_FOUND");
  });
});

describe("chat service: tenant isolation", () => {
  it("A cannot read, list or delete B's messages even with B's valid ids", async () => {
    const secret = await createMessage(ownerB, { body: "B'nin gizli mesajı" });

    expect(await code(getMessage(owner, secret.id))).toBe("NOT_FOUND");
    expect(await code(deleteMessage(owner, secret.id))).toBe("NOT_FOUND");
    expect(await code(deleteMessage(admin, secret.id))).toBe("NOT_FOUND");

    const page = await listMessages(owner, { limit: 100 });
    expect(page.messages.some((m) => m.id === secret.id)).toBe(false);

    // A cursor taken from B's message only filters A's own rows.
    const before = await listMessages(owner, { before: encodeCursor(new Date(Date.now() + 60_000), secret.id) });
    expect(before.messages.every((m) => m.id !== secret.id)).toBe(true);
    const after = await listMessagesAfter(owner, { after: encodeCursor(new Date(0), "a") });
    expect(after.every((m) => m.id !== secret.id)).toBe(true);
    const live = await listLiveIdsFrom(owner, encodeCursor(new Date(0), "a"));
    expect(live.ids).not.toContain(secret.id);

    // Still there for B.
    expect((await getMessage(ownerB, secret.id)).body).toBe("B'nin gizli mesajı");
  });

  it("B only ever sees B's messages", async () => {
    const page = await listMessages(ownerB, { limit: 100 });
    const ids = page.messages.map((m) => m.id);
    const rows = await db.chatMessage.findMany({ where: { id: { in: ids } }, select: { workspaceId: true } });
    expect(rows.every((r) => r.workspaceId === ownerB.workspaceId)).toBe(true);
  });
});

describe("chat service: permissions", () => {
  it("a member cannot delete another member's message", async () => {
    const m = await createMessage(alice, { body: "Alice yazdı" });
    expect(await code(deleteMessage(bob, m.id))).toBe("FORBIDDEN");
    expect(await db.chatMessage.count({ where: { id: m.id } })).toBe(1);
  });

  it("a forged ADMIN role in ctx does not grant deletion (role is re-read from the DB)", async () => {
    const m = await createMessage(alice, { body: "Alice yine yazdı" });
    expect(await code(deleteMessage({ ...bob, role: "ADMIN" }, m.id))).toBe("FORBIDDEN");
  });

  it("authors delete their own; admins and owners delete anyone's", async () => {
    const own = await createMessage(bob, { body: "Bob'un mesajı" });
    expect(await deleteMessage(bob, own.id)).toEqual({ id: own.id });

    const m1 = await createMessage(alice, { body: "silinecek 1" });
    const m2 = await createMessage(alice, { body: "silinecek 2" });
    expect(await code(deleteMessage(admin, m1.id))).toBe("OK");
    expect(await code(deleteMessage(owner, m2.id))).toBe("OK");
    expect(await db.chatMessage.count({ where: { id: { in: [own.id, m1.id, m2.id] } } })).toBe(0);
    expect(await code(deleteMessage(owner, m2.id))).toBe("NOT_FOUND");
  });
});

describe("chat service: pagination ordering", () => {
  let ws: TenantContext;
  const ids: string[] = [];

  beforeAll(async () => {
    const u = await createTestUser();
    ({ ctx: ws } = await createTestWorkspace(u.id));
    // 7 messages, several sharing one createdAt to exercise the id tie-breaker.
    const base = Date.now() - 60_000;
    const times = [0, 1000, 1000, 1000, 2000, 3000, 3000];
    for (let i = 0; i < times.length; i++) {
      const row = await db.chatMessage.create({
        data: { workspaceId: ws.workspaceId, authorId: ws.userId, body: `m${i}`, createdAt: new Date(base + times[i]) },
      });
      ids.push(row.id);
    }
  });

  it("pages backwards with a (createdAt, id) cursor without gaps or duplicates", async () => {
    const seen: string[] = [];
    let page = await listMessages(ws, { limit: 3 });
    expect(page.messages).toHaveLength(3);
    seen.unshift(...page.messages.map((m) => m.id));
    while (page.hasMore) {
      page = await listMessages(ws, { before: page.messages[0].cursor, limit: 3 });
      seen.unshift(...page.messages.map((m) => m.id));
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);

    const all = await db.chatMessage.findMany({
      where: { workspaceId: ws.workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    expect(seen).toEqual(all.map((r) => r.id));
  });

  it("returns each page oldest-first and listMessagesAfter strictly after the cursor", async () => {
    const { messages } = await listMessages(ws, { limit: 100 });
    for (let i = 1; i < messages.length; i++) {
      expect(compareCursor(messages[i - 1].cursor, messages[i].cursor)).toBeLessThan(0);
    }
    const after = await listMessagesAfter(ws, { after: messages[2].cursor });
    expect(after.map((m) => m.id)).toEqual(messages.slice(3).map((m) => m.id));
    expect(await listMessagesAfter(ws, { after: messages.at(-1)!.cursor })).toEqual([]);
  });

  it("listLiveIdsFrom includes the cursor row itself and everything newer", async () => {
    const { messages } = await listMessages(ws, { limit: 100 });
    const live = await listLiveIdsFrom(ws, messages[4].cursor);
    expect(new Set(live.ids)).toEqual(new Set(messages.slice(4).map((m) => m.id)));
    expect(live.complete).toBe(true);
  });

  it("rejects malformed cursors", async () => {
    expect(await code(listMessages(ws, { before: "nope" }))).toBe("VALIDATION");
    expect(await code(listMessagesAfter(ws, { after: "1_ABC;drop" }))).toBe("VALIDATION");
    expect(decodeCursor("123_abc")).toEqual({ createdAt: new Date(123), id: "abc" });
    expect(decodeCursor(null)).toBeNull();
  });
});

describe("channel authorisation", () => {
  it("parses only private-workspace-<id>", () => {
    expect(parseWorkspaceChannel(workspaceChannel("abc123"))).toBe("abc123");
    for (const bad of [
      "",
      "private-workspace-",
      "workspace-abc",
      "presence-workspace-abc",
      "private-workspace-abc-extra",
      "private-workspace-ABC",
      "private-workspace-abc;x",
      "private-workspace-../abc",
      `private-workspace-${"a".repeat(65)}`,
      " private-workspace-abc",
      null,
      42,
      ["private-workspace-abc"],
    ]) {
      expect(parseWorkspaceChannel(bad)).toBeNull();
    }
  });

  it("a member of A gets A's channel but never B's", async () => {
    expect(await authorizeChatChannel(alice.userId, workspaceChannel(owner.workspaceId))).toEqual({
      allow: true,
      workspaceId: owner.workspaceId,
    });
    expect(await authorizeChatChannel(alice.userId, workspaceChannel(ownerB.workspaceId))).toEqual({
      allow: false,
      reason: "NOT_A_MEMBER",
    });
    expect(await authorizeChatChannel(ownerB.userId, workspaceChannel(owner.workspaceId))).toMatchObject({
      allow: false,
    });
  });

  it("denies malformed channel names, unknown workspaces and missing users", async () => {
    expect(await authorizeChatChannel(alice.userId, `private-${owner.workspaceId}`)).toEqual({
      allow: false,
      reason: "MALFORMED_CHANNEL",
    });
    expect(await authorizeChatChannel(alice.userId, `${workspaceChannel(owner.workspaceId)}-x`)).toMatchObject({
      allow: false,
    });
    expect(await authorizeChatChannel(alice.userId, workspaceChannel("doesnotexist123"))).toMatchObject({
      allow: false,
      reason: "NOT_A_MEMBER",
    });
    expect(await authorizeChatChannel(null, workspaceChannel(owner.workspaceId))).toEqual({
      allow: false,
      reason: "NO_USER",
    });
    expect(await authorizeChatChannel("", workspaceChannel(owner.workspaceId))).toMatchObject({ allow: false });
  });
});

describe("chat UI helpers", () => {
  const author = { id: "u1", name: "Ayşe", email: "a@x.test", image: null };
  const msg = (id: string, ms: number) => ({
    id,
    body: id,
    createdAt: new Date(ms).toISOString(),
    authorId: author.id,
    author,
    cursor: encodeCursor(new Date(ms), id),
  });

  it("mergeMessages dedupes by id, keeps cursor order and skips deleted ids", () => {
    const cur = [msg("a", 1), msg("c", 3)];
    const merged = mergeMessages(cur, [msg("b", 2), msg("c", 3), msg("d", 4)], new Set(["d"]));
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(mergeMessages(cur, [msg("a", 1)])).toBe(cur);
  });

  it("dropDeleted only judges messages inside [from, upTo]", () => {
    const cur = [msg("a", 1), msg("b", 2), msg("c", 3), msg("d", 4)];
    const next = dropDeleted(cur, ["b"], cur[1].cursor, cur[2].cursor);
    expect(next.map((m) => m.id)).toEqual(["a", "b", "d"]);
  });

  it("groupFeed adds day separators and groups one author's burst", () => {
    const now = new Date(2026, 10, 11, 12, 0);
    const item = (key: string, d: Date, id = "u1"): FeedItem => ({
      key,
      id: key,
      body: key,
      createdAt: d,
      author: { ...author, id },
      status: "sent",
    });
    const rows = groupFeed(
      [
        item("1", new Date(2026, 10, 10, 9, 0)),
        item("2", new Date(2026, 10, 11, 9, 0)),
        item("3", new Date(2026, 10, 11, 9, 2)),
        item("4", new Date(2026, 10, 11, 9, 3), "u2"),
        item("5", new Date(2026, 10, 11, 9, 30), "u2"),
      ],
      now,
    );
    expect(rows.map((r) => (r.type === "day" ? r.label : r.items.map((i) => i.key).join("+")))).toEqual([
      "Dün",
      "1",
      "Bugün",
      "2+3",
      "4",
      "5",
    ]);
  });

  it("tokenizeLinks links only http(s) URLs and trims trailing punctuation", () => {
    expect(tokenizeLinks("Bkz. https://ornek.com/a?b=1, ve (www.test.org).")).toEqual([
      { type: "text", value: "Bkz. " },
      { type: "link", value: "https://ornek.com/a?b=1", href: "https://ornek.com/a?b=1" },
      { type: "text", value: ", ve (" },
      { type: "link", value: "www.test.org", href: "https://www.test.org/" },
      { type: "text", value: ")." },
    ]);
    expect(tokenizeLinks("javascript:alert(1) <b>x</b>")).toEqual([
      { type: "text", value: "javascript:alert(1) <b>x</b>" },
    ]);
  });
});
