import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { addComment } from "@/server/comments";
import { ServiceError } from "@/server/errors";
import { createPost } from "@/server/messages";
import {
  countSubscribers,
  isSubscribed,
  listSubscriberIds,
  subscribe,
  unsubscribe,
} from "@/server/subscriptions";

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

describe("subscriptions service", () => {
  let owner: TenantContext;
  let alice: TenantContext;
  let bob: TenantContext;
  let carol: TenantContext;
  let other: TenantContext;

  beforeAll(async () => {
    const u = await createTestUser({ name: "Sahip" });
    owner = (await createTestWorkspace(u.id)).ctx;
    alice = (await createMember(owner.workspaceId)).ctx;
    bob = (await createMember(owner.workspaceId)).ctx;
    carol = (await createMember(owner.workspaceId)).ctx;
    const o = await createTestUser();
    other = (await createTestWorkspace(o.id)).ctx;
  });

  it("subscribes the author on create and lets members toggle themselves", async () => {
    const post = await createPost(alice, { title: "Duyuru", body: "metin" });
    const subject = { type: "post", id: post.id } as const;
    expect(await isSubscribed(alice, subject)).toBe(true);
    expect(await isSubscribed(bob, subject)).toBe(false);
    await subscribe(bob, subject);
    await subscribe(bob, subject); // idempotent
    expect(await countSubscribers(owner, subject)).toBe(2);
    await unsubscribe(bob, subject);
    expect(await isSubscribed(bob, subject)).toBe(false);
  });

  it("notifies subscribers of a comment, not every member", async () => {
    const post = await createPost(alice, { title: "Konu", body: "metin" });
    const subject = { type: "post", id: post.id } as const;
    await subscribe(bob, subject);
    await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
    await addComment(owner, subject, { body: "yorum" });
    const rows = await db.notification.findMany({ where: { workspaceId: owner.workspaceId } });
    const recipients = rows.map((r) => r.userId).sort();
    expect(recipients).toEqual([alice.userId, bob.userId].sort());
    expect(recipients).not.toContain(carol.userId);
    // The commenter became a subscriber.
    expect(await listSubscriberIds(owner, subject)).toContain(owner.userId);
  });

  it("does not reach into other workspaces", async () => {
    const post = await createPost(alice, { title: "Gizli", body: "metin" });
    const subject = { type: "post", id: post.id } as const;
    expect(await code(subscribe(other, subject))).toBe("NOT_FOUND");
    expect(await code(isSubscribed(other, subject))).toBe("NOT_FOUND");
    expect(await code(subscribe(owner, { type: "bogus", id: post.id }))).toBe("VALIDATION");
  });
});
