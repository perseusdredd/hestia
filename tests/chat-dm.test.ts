import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  deleteMessage,
  getMessage,
  listConversations,
  listLiveIdsFrom,
  listMessages,
  listMessagesAfter,
  sendChatMessage,
} from "@/server/chat";
import { answerMention, CLAUDE_BOT_ID, ensureClaudeMember } from "@/server/claude-bot";
import { notifyChatDm, markDmRead } from "@/server/notifications";
import { listTodoLists } from "@/server/todos";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";
import type { TenantContext } from "@/lib/tenant-context";

let owner: TenantContext;
let alice: TenantContext;
let bob: TenantContext;
let ws: string;

beforeAll(async () => {
  const u = await createTestUser();
  const { workspace, ctx } = await createTestWorkspace(u.id);
  owner = ctx;
  ws = workspace.id;
  alice = (await createMember(ws, "MEMBER")).ctx;
  bob = (await createMember(ws, "MEMBER")).ctx;
  await ensureClaudeMember(db, ws);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});
afterAll(async () => {
  await db.chatMessage.deleteMany({ where: { workspaceId: ws } });
  await cleanup();
});

describe("direct messages", () => {
  it("are visible only to the two people, never in the public room", async () => {
    const dm = await sendChatMessage(alice, { body: "gizli selam", peerId: bob.userId });
    await sendChatMessage(alice, { body: "herkese selam" });

    const aliceView = await listMessages(alice, { peer: bob.userId });
    const bobView = await listMessages(bob, { peer: alice.userId });
    expect(aliceView.messages.map((m) => m.body)).toEqual(["gizli selam"]);
    expect(bobView.messages.map((m) => m.body)).toEqual(["gizli selam"]);

    const room = await listMessages(bob);
    expect(room.messages.map((m) => m.body)).toEqual(["herkese selam"]);
    // The owner (even an OWNER) cannot read it, by list, poll, live ids or id.
    expect((await listMessages(owner, { peer: alice.userId })).messages).toEqual([]);
    expect((await listMessagesAfter(owner, { after: "0_a" })).map((m) => m.body)).not.toContain("gizli selam");
    expect((await listLiveIdsFrom(owner, "0_a")).ids).not.toContain(dm.message.id);
    await expect(getMessage(owner, dm.message.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(deleteMessage(owner, dm.message.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getMessage(bob, dm.message.id)).resolves.toMatchObject({ body: "gizli selam" });
  });

  it("only go to members of the same workspace, not yourself", async () => {
    const outsider = await createTestUser();
    await expect(sendChatMessage(alice, { body: "x", peerId: outsider.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sendChatMessage(alice, { body: "x", peerId: alice.userId })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("lists conversations and keeps one unread notification until opened", async () => {
    await notifyChatDm(alice, bob.userId, "merhaba");
    await notifyChatDm(alice, bob.userId, "tekrar");
    expect(await db.notification.count({ where: { userId: bob.userId, type: "CHAT_DM", readAt: null } })).toBe(1);
    const convo = (await listConversations(bob)).find((c) => c.userId === alice.userId);
    expect(convo?.unread).toBe(true);
    expect(convo?.lastText).toBe("gizli selam");
    await markDmRead(bob, alice.userId);
    expect((await listConversations(bob)).find((c) => c.userId === alice.userId)?.unread).toBe(false);
  });
});

describe("Claude in a private chat", () => {
  it("answers every message there and can add a to-do with its tools", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    const replies = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "create_todo", input: { title: "Rapor yaz", list_name: "Claude testi" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Ekledim." }] },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(replies.shift())));
    vi.stubGlobal("fetch", fetchMock);

    const { message } = await sendChatMessage(alice, { body: "rapor görevi ekle", peerId: CLAUDE_BOT_ID });
    await answerMention(ws, message.id, undefined, { dmWith: alice.userId });

    const reply = await db.chatMessage.findFirst({ where: { workspaceId: ws, authorId: CLAUDE_BOT_ID }, orderBy: { createdAt: "desc" } });
    expect(reply).toMatchObject({ body: "Ekledim.", recipientId: alice.userId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lists = await listTodoLists(owner);
    const item = lists.find((l) => l.name === "Claude testi")?.items[0];
    expect(item).toMatchObject({ title: "Rapor yaz" });
    // The private answer never shows up in the public room or for others.
    expect((await listMessages(bob)).messages.some((m) => m.body === "Ekledim.")).toBe(false);
  });
});
