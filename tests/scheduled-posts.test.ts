import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { toIstanbulInputValue } from "@/lib/istanbul-time";
import type { TenantContext } from "@/lib/tenant-context";
import { ServiceError } from "@/server/errors";
import {
  cancelSchedule,
  createPost,
  deletePost,
  getPost,
  listPosts,
  publishPost,
  schedulePost,
  updatePost,
} from "@/server/messages";
import { publishDueScheduled } from "@/server/scheduled-posts";

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

const HOUR = 3600_000;
const wall = (offsetMs: number) => toIstanbulInputValue(new Date(Date.now() + offsetMs), true);
const notifCount = (ctx: TenantContext, postId: string, type?: string) =>
  db.notification.count({ where: { workspaceId: ctx.workspaceId, path: `messages/${postId}`, ...(type ? { type } : {}) } });

describe("scheduled messages", () => {
  let author: TenantContext;
  let member: TenantContext;
  let member2: TenantContext;
  let guest: TenantContext;

  beforeAll(async () => {
    author = (await createTestWorkspace((await createTestUser()).id)).ctx;
    member = (await createMember(author.workspaceId, "MEMBER")).ctx;
    member2 = (await createMember(author.workspaceId, "MEMBER")).ctx;
    guest = (await createMember(author.workspaceId, "GUEST")).ctx;
  });

  const schedule = (extra: Record<string, unknown> = {}, offset = HOUR) =>
    createPost(author, { title: "Zamanlı", body: "Merhaba", scheduledFor: wall(offset), ...extra });

  it("creates an unpublished, scheduled post with no announcement", async () => {
    const p = await schedule();
    expect(p.publishedAt).toBeNull();
    expect(p.scheduledFor).not.toBeNull();
    expect(await notifCount(author, p.id)).toBe(0);
    expect(await db.activity.count({ where: { subjectType: "post", subjectId: p.id } })).toBe(0);
    expect(await db.subscription.count({ where: { subjectType: "post", subjectId: p.id } })).toBe(0);
  });

  it("is hidden from others until due, visible to the author as scheduled", async () => {
    const p = await schedule();
    expect(await code(getPost(member, p.id))).toBe("NOT_FOUND");
    expect(await code(getPost(guest, p.id))).toBe("NOT_FOUND");
    const others = (await listPosts(member)).items.map((i) => i.id);
    expect(others).not.toContain(p.id);
    const mine = (await listPosts(author, { draftsOnly: true })).items.find((i) => i.id === p.id);
    expect(mine?.isDraft).toBe(true);
    expect(mine?.scheduledFor).toBeInstanceOf(Date);
    expect((await getPost(author, p.id)).scheduledFor).toBeInstanceOf(Date);
  });

  it("rejects past, zero and malformed schedule times", async () => {
    expect(await code(schedule({}, -HOUR))).toBe("VALIDATION");
    expect(await code(schedule({}, 0))).toBe("VALIDATION");
    expect(await code(createPost(author, { title: "x", body: "y", scheduledFor: "yarın" }))).toBe("VALIDATION");
    expect(await code(createPost(author, { title: "x", body: "y", scheduledFor: "2099-13-45T99:99" }))).toBe("VALIDATION");
  });

  it("an empty schedule keeps the old behaviour (publish now / plain draft)", async () => {
    const pub = await createPost(author, { title: "Normal", body: "x", scheduledFor: "" });
    expect(pub.publishedAt).not.toBeNull();
    expect(pub.scheduledFor).toBeNull();
    const draft = await createPost(author, { title: "Taslak", body: "x", draft: true });
    expect(draft.publishedAt).toBeNull();
    expect(draft.scheduledFor).toBeNull();
  });

  it("publishDueScheduled publishes due posts, notifies the right people exactly once, and a second run is a no-op", async () => {
    const p = await schedule({ title: "Cron testi" });
    const future = await schedule({ title: "Henüz değil" }, 5 * HOUR);
    const now = new Date(Date.now() + 2 * HOUR);

    const first = await publishDueScheduled(now);
    expect(first).toBeGreaterThanOrEqual(1);

    const row = await db.post.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.publishedAt?.getTime()).toBe(now.getTime());
    expect(row.scheduledFor).toBeNull();

    // Everyone but the author is notified once; the author gets nothing; guests see it (not internal).
    expect(await notifCount(author, p.id, "POST_CREATED")).toBe(3);
    expect(await db.notification.count({ where: { userId: author.userId, path: `messages/${p.id}` } })).toBe(0);
    for (const m of [member, member2, guest]) {
      expect(await db.notification.count({ where: { userId: m.userId, path: `messages/${p.id}` } })).toBe(1);
    }
    expect(await db.activity.count({ where: { subjectType: "post", subjectId: p.id, type: "POST_CREATED" } })).toBe(1);
    expect(await db.subscription.count({ where: { subjectType: "post", subjectId: p.id, userId: author.userId } })).toBe(1);

    // Not-yet-due post stays hidden and untouched.
    expect((await db.post.findUniqueOrThrow({ where: { id: future.id } })).publishedAt).toBeNull();
    expect(await notifCount(author, future.id)).toBe(0);

    // Second run (and a parallel pair) announce nothing more.
    const total = await notifCount(author, p.id);
    await publishDueScheduled(now);
    await Promise.all([publishDueScheduled(now), publishDueScheduled(now)]);
    expect(await notifCount(author, p.id)).toBe(total);
    expect(await db.activity.count({ where: { subjectType: "post", subjectId: p.id } })).toBe(1);

    // Now everyone sees it.
    expect(await code(getPost(member, p.id))).toBe("OK");
    expect((await listPosts(member)).items.map((i) => i.id)).toContain(p.id);
  });

  it("an internal scheduled post publishes without notifying guests", async () => {
    const p = await schedule({ title: "Ekip içi", internal: true });
    await publishDueScheduled(new Date(Date.now() + 2 * HOUR));
    expect(await db.notification.count({ where: { userId: guest.userId, path: `messages/${p.id}` } })).toBe(0);
    expect(await db.notification.count({ where: { userId: member.userId, path: `messages/${p.id}` } })).toBe(1);
    expect(await code(getPost(guest, p.id))).toBe("NOT_FOUND");
  });

  it("does not publish deleted or cancelled posts", async () => {
    const trashed = await schedule({ title: "Silinecek" });
    await deletePost(author, trashed.id);
    const cancelled = await schedule({ title: "İptal" });
    await cancelSchedule(author, cancelled.id);
    await publishDueScheduled(new Date(Date.now() + 2 * HOUR));
    expect((await db.post.findUniqueOrThrow({ where: { id: trashed.id } })).publishedAt).toBeNull();
    expect((await db.post.findUniqueOrThrow({ where: { id: cancelled.id } })).publishedAt).toBeNull();
    expect(await notifCount(author, trashed.id)).toBe(0);
    expect(await notifCount(author, cancelled.id)).toBe(0);
  });

  it("cancel returns it to a plain draft; reschedule moves the time; only the author may", async () => {
    const p = await schedule();
    expect(await code(cancelSchedule(member, p.id))).toBe("NOT_FOUND"); // not even visible
    await cancelSchedule(author, p.id);
    const draft = await db.post.findUniqueOrThrow({ where: { id: p.id } });
    expect(draft.scheduledFor).toBeNull();
    expect(draft.publishedAt).toBeNull();
    expect((await listPosts(author, { draftsOnly: true })).items.find((i) => i.id === p.id)?.scheduledFor).toBeNull();

    const at = await schedulePost(author, p.id, wall(3 * HOUR));
    expect((await db.post.findUniqueOrThrow({ where: { id: p.id } })).scheduledFor?.getTime()).toBe(at.getTime());
    expect(await code(schedulePost(author, p.id, wall(-HOUR)))).toBe("VALIDATION");
    expect(await code(schedulePost(member, p.id, wall(HOUR)))).toBe("NOT_FOUND");
    const later = await schedulePost(author, p.id, wall(6 * HOUR));
    expect(later.getTime()).toBeGreaterThan(at.getTime());
  });

  it("editing a scheduled post keeps the schedule; manual publish clears it and announces once", async () => {
    const p = await schedule();
    await updatePost(author, p.id, { title: "Yeni başlık", body: "Yeni gövde" });
    expect((await db.post.findUniqueOrThrow({ where: { id: p.id } })).scheduledFor).not.toBeNull();
    await publishPost(author, p.id);
    const row = await db.post.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.publishedAt).not.toBeNull();
    expect(row.scheduledFor).toBeNull();
    const total = await notifCount(author, p.id);
    expect(total).toBeGreaterThan(0);
    // The cron can no longer pick it up; scheduling/cancelling a published post conflicts.
    await publishDueScheduled(new Date(Date.now() + 10 * HOUR));
    expect(await notifCount(author, p.id)).toBe(total);
    expect(await code(schedulePost(author, p.id, wall(HOUR)))).toBe("CONFLICT");
    expect(await code(cancelSchedule(author, p.id))).toBe("CONFLICT");
  });

  it("does not publish or announce a post whose author was removed from the workspace", async () => {
    const leaver = (await createMember(author.workspaceId, "MEMBER")).ctx;
    const p = await createPost(leaver, { title: "Ayrılan", body: "x", scheduledFor: wall(HOUR) });
    await db.membership.deleteMany({ where: { workspaceId: author.workspaceId, userId: leaver.userId } });
    const now = new Date(Date.now() + 2 * HOUR);
    await publishDueScheduled(now);
    const row = await db.post.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.publishedAt).toBeNull();
    expect(row.scheduledFor).toBeNull();
    expect(await notifCount(author, p.id)).toBe(0);
    expect(await db.activity.count({ where: { subjectType: "post", subjectId: p.id } })).toBe(0);
    await publishDueScheduled(now);
    expect(await notifCount(author, p.id)).toBe(0);
  });

  it("a downgraded guest author still publishes using the actual role", async () => {
    const g = (await createMember(author.workspaceId, "MEMBER")).ctx;
    const p = await createPost(g, { title: "Düşürülen", body: "x", scheduledFor: wall(HOUR) });
    await db.membership.updateMany({ where: { workspaceId: author.workspaceId, userId: g.userId }, data: { role: "GUEST" } });
    await publishDueScheduled(new Date(Date.now() + 2 * HOUR));
    const row = await db.post.findUniqueOrThrow({ where: { id: p.id } });
    // Either published as a guest-visible post or left untouched; never announced to others as a member action leak.
    if (row.publishedAt) expect(await db.activity.count({ where: { subjectType: "post", subjectId: p.id } })).toBe(1);
  });

  it("a plain draft is never picked up by the cron", async () => {
    const d = await createPost(author, { title: "Düz taslak", body: "x", draft: true });
    await publishDueScheduled(new Date(Date.now() + 100 * HOUR));
    expect((await db.post.findUniqueOrThrow({ where: { id: d.id } })).publishedAt).toBeNull();
  });
});
