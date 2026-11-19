import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { createEvent, deleteEvent } from "@/server/calendar";
import { deleteMessage, sendChatMessage } from "@/server/chat";
import { ServiceError } from "@/server/errors";
import { createDocument, deleteDocument } from "@/server/files";
import { listReactions, toggleReaction } from "@/server/reactions";
import { createTodoItem, createTodoList, deleteTodoItem, deleteTodoList } from "@/server/todos";
import { purgeTrashItem } from "@/server/trash";

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

const EVENT = { startsAt: "2026-03-10T10:00", endsAt: "2026-03-10T11:00" };

describe("reactions on chat messages, to-dos, documents and events", () => {
  let owner: TenantContext;
  let alice: TenantContext;
  let bob: TenantContext;
  let guest: TenantContext;
  let other: TenantContext;

  beforeAll(async () => {
    const u = await createTestUser({ name: "Sahip2" });
    owner = (await createTestWorkspace(u.id)).ctx;
    alice = (await createMember(owner.workspaceId)).ctx;
    bob = (await createMember(owner.workspaceId)).ctx;
    guest = (await createMember(owner.workspaceId, "GUEST")).ctx;
    const o = await createTestUser();
    other = (await createTestWorkspace(o.id)).ctx;
  });

  async function subjects() {
    const list = await createTodoList(owner, { name: "Liste" });
    const item = await createTodoItem(owner, list.id, { title: "Gorev" });
    const doc = await createDocument(owner, { title: "Dok", content: "c" });
    const ev = await createEvent(owner, { title: "Etkinlik", ...EVENT });
    const msg = (await sendChatMessage(owner, { body: "selam" })).message;
    return [
      ["todoItem", item.id],
      ["document", doc.id],
      ["event", ev.id],
      ["chatMessage", msg.id],
    ] as const;
  }

  it("toggles and groups counts on every new surface", async () => {
    for (const [type, id] of await subjects()) {
      expect((await toggleReaction(owner, { type, id }, "👍")).active).toBe(true);
      expect((await toggleReaction(alice, { type, id }, "👍")).active).toBe(true);
      expect((await toggleReaction(alice, { type, id }, "🎉")).active).toBe(true);
      expect((await listReactions(alice, type, [id]))[id]).toEqual([
        { emoji: "👍", count: 2, mine: true },
        { emoji: "🎉", count: 1, mine: true },
      ]);
      expect((await toggleReaction(alice, { type, id }, "👍")).active).toBe(false);
      expect((await listReactions(owner, type, [id]))[id]).toEqual([
        { emoji: "👍", count: 1, mine: true },
        { emoji: "🎉", count: 1, mine: false },
      ]);
    }
  });

  it("rejects invalid emoji and subjects of another workspace", async () => {
    for (const [type, id] of await subjects()) {
      expect(await code(toggleReaction(owner, { type, id }, "💩"))).toBe("VALIDATION");
      expect(await code(toggleReaction(other, { type, id }, "👍"))).toBe("NOT_FOUND");
      expect(await code(toggleReaction(owner, { type, id: "nope" }, "👍"))).toBe("NOT_FOUND");
      await toggleReaction(owner, { type, id }, "👍");
      expect((await listReactions(other, type, [id]))[id]).toBeUndefined();
    }
  });

  it("a guest cannot react to internal to-dos, documents and events, nor to chat", async () => {
    const list = await createTodoList(owner, { name: "Gizli", internal: true });
    const item = await createTodoItem(owner, list.id, { title: "g" });
    const doc = await createDocument(owner, { title: "Gizli dok", content: "c", internal: true });
    const ev = await createEvent(owner, { title: "Gizli etk", ...EVENT, internal: true });
    const msg = (await sendChatMessage(owner, { body: "ekip" })).message;
    for (const [type, id] of [
      ["todoItem", item.id],
      ["document", doc.id],
      ["event", ev.id],
    ] as const) {
      expect(await code(toggleReaction(guest, { type, id }, "👍"))).toBe("NOT_FOUND");
      await toggleReaction(owner, { type, id }, "👍");
      expect((await listReactions(guest, type, [id]))[id]).toBeUndefined();
      expect((await listReactions(owner, type, [id]))[id]).toHaveLength(1);
    }
    expect(await code(toggleReaction(guest, { type: "chatMessage", id: msg.id }, "👍"))).toBe("FORBIDDEN");
    await toggleReaction(owner, { type: "chatMessage", id: msg.id }, "👍");
    expect(await listReactions(guest, "chatMessage", [msg.id])).toEqual({});
  });

  it("a guest can react to non-internal to-dos, documents and events", async () => {
    const list = await createTodoList(owner, { name: "Acik" });
    const item = await createTodoItem(owner, list.id, { title: "a" });
    const doc = await createDocument(owner, { title: "Acik dok", content: "c" });
    const ev = await createEvent(owner, { title: "Acik etk", ...EVENT });
    for (const [type, id] of [
      ["todoItem", item.id],
      ["document", doc.id],
      ["event", ev.id],
    ] as const) {
      expect((await toggleReaction(guest, { type, id }, "❤️")).active).toBe(true);
      expect((await listReactions(owner, type, [id]))[id]).toEqual([{ emoji: "❤️", count: 1, mine: false }]);
    }
  });

  it("a DM reaction is limited to its two participants", async () => {
    const dm = (await sendChatMessage(alice, { body: "ozel", peerId: bob.userId })).message;
    const subject = { type: "chatMessage", id: dm.id };
    expect(await code(toggleReaction(owner, subject, "👍"))).toBe("NOT_FOUND");
    expect((await toggleReaction(bob, subject, "👍")).active).toBe(true);
    expect((await toggleReaction(alice, subject, "🎉")).active).toBe(true);
    expect(await listReactions(owner, "chatMessage", [dm.id])).toEqual({});
    expect((await listReactions(alice, "chatMessage", [dm.id]))[dm.id]).toHaveLength(2);
  });

  it("deleting the subject removes its reactions", async () => {
    const all = await subjects();
    for (const [type, id] of all) await toggleReaction(alice, { type, id }, "👀");
    const [item, doc, ev, msg] = all;
    await deleteTodoItem(owner, item[1]);
    await deleteDocument(owner, doc[1]);
    await deleteEvent(owner, ev[1]);
    await deleteMessage(owner, msg[1]);
    for (const [type, id] of all) {
      expect(await db.reaction.count({ where: { subjectType: type, subjectId: id } })).toBe(0);
      expect(await code(toggleReaction(alice, { type, id }, "👀"))).toBe("NOT_FOUND");
    }
  });

  it("purging a trashed list removes the reactions of its items", async () => {
    const list = await createTodoList(owner, { name: "Liste cop" });
    const item = await createTodoItem(owner, list.id, { title: "i" });
    await toggleReaction(alice, { type: "todoItem", id: item.id }, "🙏");
    await deleteTodoList(owner, list.id);
    await purgeTrashItem(owner, { kind: "todoList", id: list.id });
    expect(await db.reaction.count({ where: { subjectType: "todoItem", subjectId: item.id } })).toBe(0);
  });
});
