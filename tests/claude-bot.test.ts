import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { CLAUDE_BOT_ID, answerMention, ensureClaudeMember, mentionsClaude } from "@/server/claude-bot";
import { sendChatMessage } from "@/server/chat";

import { cleanup, createTestUser, createTestWorkspace } from "./helpers";

let ws: string;
let owner: Awaited<ReturnType<typeof createTestUser>>;

beforeAll(async () => {
  owner = await createTestUser();
  ws = (await createTestWorkspace(owner.id)).workspace.id;
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

const lastBot = () =>
  db.chatMessage.findFirst({ where: { workspaceId: ws, authorId: CLAUDE_BOT_ID }, orderBy: { createdAt: "desc" } });

describe("Claude bot", () => {
  it("detects @Claude mentions only as a whole word", () => {
    expect(mentionsClaude("@Claude merhaba")).toBe(true);
    expect(mentionsClaude("selam @claude, nasılsın")).toBe(true);
    expect(mentionsClaude("mail@claude.com")).toBe(false);
    expect(mentionsClaude("@Claudette")).toBe(false);
    expect(mentionsClaude("Claude")).toBe(false);
  });

  it("is a MEMBER of the workspace without a password", async () => {
    const m = await db.membership.findUnique({
      where: { userId_workspaceId: { userId: CLAUDE_BOT_ID, workspaceId: ws } },
    });
    expect(m?.role).toBe("MEMBER");
    expect((await db.user.findUnique({ where: { id: CLAUDE_BOT_ID } }))?.passwordHash).toBeNull();
  });

  it("answers a mention via the API", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "Merhaba!" }] })));
    vi.stubGlobal("fetch", fetchMock);
    const { message } = await sendChatMessage(
      { userId: owner.id, workspaceId: ws, role: "OWNER" },
      { body: "@Claude selam" },
    );
    await answerMention(ws, message.id);
    expect((await lastBot())?.body).toBe("Merhaba!");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("says it is not configured without an API key, and stays silent if removed", async () => {
    const { message } = await sendChatMessage(
      { userId: owner.id, workspaceId: ws, role: "OWNER" },
      { body: "@Claude orada mısın" },
    );
    await answerMention(ws, message.id);
    expect((await lastBot())?.body).toContain("ANTHROPIC_API_KEY");

    await db.membership.delete({ where: { userId_workspaceId: { userId: CLAUDE_BOT_ID, workspaceId: ws } } });
    const before = await db.chatMessage.count({ where: { workspaceId: ws, authorId: CLAUDE_BOT_ID } });
    await answerMention(ws, message.id);
    expect(await db.chatMessage.count({ where: { workspaceId: ws, authorId: CLAUDE_BOT_ID } })).toBe(before);
  });
});
