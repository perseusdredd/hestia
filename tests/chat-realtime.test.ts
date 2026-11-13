import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { collectAfter, maxCursor, mergeMessages, syncAfterCursor } from "@/components/chat/chat-utils";
import { db } from "@/lib/db";
import type { ChatMessagesResponse } from "@/lib/pusher/chat-protocol";
import { __setPusherLoaderForTests, getPusherClient } from "@/lib/pusher/client";
import type { TenantContext } from "@/lib/tenant-context";
import { CHAT_RATE_LIMIT, createMessage, listMessagesAfterPage, sendRateLimitedMessage } from "@/server/chat";
import { ServiceError } from "@/server/errors";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

vi.mock("server-only", () => ({}));

let owner: TenantContext;
let alice: TenantContext;

beforeAll(async () => {
  const u = await createTestUser();
  ({ ctx: owner } = await createTestWorkspace(u.id));
  ({ ctx: alice } = await createMember(owner.workspaceId, "MEMBER"));
});

afterAll(async () => {
  await cleanup();
});

describe("Pusher events never carry message content (removed-member leak regression)", () => {
  it("publishChatMessage sends only a reference, even for small messages", async () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { __hestiaPusher: unknown }).__hestiaPusher = { trigger };
    const { publishChatMessage } = await import("@/lib/pusher/server");
    const m = await createMessage(alice, { body: "gizli içerik" });
    await publishChatMessage(owner.workspaceId, m, "client-id-123");

    expect(trigger).toHaveBeenCalledTimes(1);
    const payload = trigger.mock.calls[0][2];
    expect(payload).toEqual({ kind: "ref", id: m.id, cursor: m.cursor, clientId: "client-id-123" });
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain("gizli içerik");
    expect(wire).not.toContain("@");
    delete (globalThis as unknown as { __hestiaPusher?: unknown }).__hestiaPusher;
  });
});

describe("sync cursor (skipped-message regression)", () => {
  it("a message created before our own newer send is still fetched by the next sync", async () => {
    const { ctx: ws } = await createTestWorkspace((await createTestUser()).id);
    const { ctx: y } = await createMember(ws.workspaceId, "MEMBER");
    const z = await createMessage(ws, { body: "Z (last poll saw this)" });
    const serverCursor = z.cursor; // what X's last sync returned
    const a = await createMessage(y, { body: "A from Y" });
    const b = await createMessage(ws, { body: "B, X's own send" });
    const shown = mergeMessages([z], [b]); // B settled from the action result

    // Old behaviour: after = newest shown (B) -> A is skipped.
    const old = await listMessagesAfterPage(ws, { after: shown.at(-1)!.cursor });
    expect(old.messages.map((m) => m.id)).not.toContain(a.id);

    const after = syncAfterCursor(serverCursor)!;
    const page = await listMessagesAfterPage(ws, { after });
    expect(page.messages.map((m) => m.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(mergeMessages(shown, page.messages).map((m) => m.id)).toEqual([z.id, a.id, b.id]);
  });

  it("a row committed late with an older createdAt than the server cursor is re-read", async () => {
    const { ctx: ws } = await createTestWorkspace((await createTestUser()).id);
    const seen = await createMessage(ws, { body: "seen" });
    const late = await db.chatMessage.create({
      data: {
        workspaceId: ws.workspaceId,
        authorId: ws.userId,
        body: "late commit",
        createdAt: new Date(new Date(seen.createdAt).getTime() - 2000),
      },
    });
    const page = await listMessagesAfterPage(ws, { after: syncAfterCursor(seen.cursor)! });
    expect(page.messages.map((m) => m.id)).toContain(late.id);
  });

  it("maxCursor keeps the newest", () => {
    expect(maxCursor(null, "5_a")).toBe("5_a");
    expect(maxCursor("9_a", "5_a")).toBe("9_a");
    expect(maxCursor("5_a", undefined)).toBe("5_a");
    expect(syncAfterCursor(null)).toBeNull();
  });
});

describe("resync paging past the 100-row cap (reconnect gap regression)", () => {
  it("listMessagesAfterPage reports hasMoreAfter and collectAfter pages through all of it", async () => {
    const { ctx: ws } = await createTestWorkspace((await createTestUser()).id);
    const base = Date.now() - 60_000;
    await db.chatMessage.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        workspaceId: ws.workspaceId,
        authorId: ws.userId,
        body: `m${i}`,
        createdAt: new Date(base + i * 10),
      })),
    });
    const start = `${base - 1}_0`;
    const first = await listMessagesAfterPage(ws, { after: start, limit: 10 });
    expect(first.messages).toHaveLength(10);
    expect(first.hasMoreAfter).toBe(true);

    const fetchPage = async (after: string): Promise<ChatMessagesResponse> =>
      listMessagesAfterPage(ws, { after, limit: 10 });
    const all = await collectAfter(first, fetchPage);
    expect(all?.truncated).toBe(false);
    expect(all?.messages.map((m) => m.body)).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`));

    const capped = await collectAfter(first, fetchPage, 2);
    expect(capped?.truncated).toBe(true);
  });
});

describe("chat rate limit under concurrency (regression)", () => {
  it("a parallel burst cannot exceed CHAT_RATE_LIMIT", async () => {
    const { ctx: burst } = await createMember(owner.workspaceId, "MEMBER");
    const results = await Promise.allSettled(
      Array.from({ length: CHAT_RATE_LIMIT + 10 }, (_, i) => sendRateLimitedMessage(burst, { body: `b${i}` })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(CHAT_RATE_LIMIT);
    for (const r of results) {
      if (r.status === "rejected") expect((r.reason as ServiceError).code).toBe("CONFLICT");
    }
    expect(await db.chatMessage.count({ where: { authorId: burst.userId } })).toBe(CHAT_RATE_LIMIT);
  });
});

describe("getPusherClient (double-connect regression)", () => {
  it("concurrent first calls share one instance", async () => {
    const created: { disconnect: () => void }[] = [];
    class FakePusher {
      disconnect = vi.fn();
      constructor() {
        created.push(this);
      }
    }
    __setPusherLoaderForTests(
      () => new Promise((resolve) => setTimeout(() => resolve(FakePusher as never), 5)),
    );
    const cfg = { key: "k", cluster: "eu" };
    const [p1, p2] = await Promise.all([getPusherClient(cfg), getPusherClient(cfg)]);
    expect(created).toHaveLength(1);
    expect(p1).toBe(p2);
    expect(await getPusherClient(cfg)).toBe(p1);

    // A different config disconnects the old socket.
    await getPusherClient({ key: "k2", cluster: "eu" });
    expect(created).toHaveLength(2);
    expect(created[0].disconnect).toHaveBeenCalled();
    __setPusherLoaderForTests(null);
  });
});

