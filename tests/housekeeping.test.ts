import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { runHousekeeping } from "@/server/housekeeping";

import { cleanup, createTestUser, createTestWorkspace, trackOutbox, uniqueSuffix } from "./helpers";

/**
 * All rows are dated around the year 2000 and the job runs with a 2000 "now",
 * so the run can only ever touch rows older than real data: the shared dev DB
 * is safe, and the assertions are exact.
 */
const NOW = new Date("2000-06-01T00:00:00Z");
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const hash = () => randomBytes(32).toString("hex");

let userId = "";
let workspaceId = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
  const user = await createTestUser();
  userId = user.id;
  const { workspace } = await createTestWorkspace(user.id);
  workspaceId = workspace.id;

  const token = (name: string, data: { expiresAt: Date; usedAt?: Date | null }) =>
    db.authToken
      .create({ data: { userId, type: "PASSWORD_RESET", tokenHash: hash(), createdAt: days(400), ...data } })
      .then((r) => (ids[name] = r.id));
  await token("tokenUsedOld", { expiresAt: NOW, usedAt: days(8) });
  await token("tokenExpiredOld", { expiresAt: days(8) });
  await token("tokenUsedRecent", { expiresAt: NOW, usedAt: days(6) });
  await token("tokenExpiredRecent", { expiresAt: days(6) });
  await token("tokenLive", { expiresAt: days(-1) });

  const invite = (name: string, data: { expiresAt: Date; acceptedAt?: Date; revokedAt?: Date }) =>
    db.invitation
      .create({
        data: {
          workspaceId,
          email: trackOutbox(`hk-${uniqueSuffix()}@hestia.test`),
          tokenHash: hash(),
          invitedById: userId,
          createdAt: days(400),
          ...data,
        },
      })
      .then((r) => (ids[name] = r.id));
  await invite("inviteExpiredOld", { expiresAt: days(31) });
  await invite("inviteRevokedOld", { expiresAt: NOW, revokedAt: days(31) });
  await invite("inviteExpiredRecent", { expiresAt: days(29) });
  await invite("inviteRevokedRecent", { expiresAt: NOW, revokedAt: days(29) });
  await invite("inviteAcceptedOld", { expiresAt: days(200), acceptedAt: days(300) });
  await invite("inviteLive", { expiresAt: days(-7) });

  const mail = (name: string, createdAt: Date) =>
    db.emailOutbox
      .create({ data: { to: trackOutbox(`hk-${uniqueSuffix()}@hestia.test`), subject: "s", text: "t", kind: "test", createdAt } })
      .then((r) => (ids[name] = r.id));
  await mail("mailOld", days(31));
  await mail("mailRecent", days(29));

  const note = (name: string, createdAt: Date, readAt: Date | null) =>
    db.notification
      .create({ data: { workspaceId, userId, type: "TEST", title: "t", path: "overview", createdAt, readAt } })
      .then((r) => (ids[name] = r.id));
  await note("noteReadOld", days(91), days(90));
  await note("noteUnreadOld", days(91), null);
  await note("noteReadRecent", days(89), days(1));
});

afterAll(async () => {
  await cleanup();
});

describe("runHousekeeping", () => {
  it("deletes only stale rows", async () => {
    const result = await runHousekeeping(NOW);
    // >= because an earlier aborted run may have left 2000-era rows behind.
    expect(result.authTokens).toBeGreaterThanOrEqual(2);
    expect(result.invitations).toBeGreaterThanOrEqual(2);
    expect(result.emailOutbox).toBeGreaterThanOrEqual(1);
    expect(result.notifications).toBeGreaterThanOrEqual(1);

    const tokens = new Set((await db.authToken.findMany({ where: { userId }, select: { id: true } })).map((r) => r.id));
    expect(tokens.has(ids.tokenUsedOld)).toBe(false);
    expect(tokens.has(ids.tokenExpiredOld)).toBe(false);
    expect(tokens.has(ids.tokenUsedRecent)).toBe(true);
    expect(tokens.has(ids.tokenExpiredRecent)).toBe(true);
    expect(tokens.has(ids.tokenLive)).toBe(true);

    const invites = new Set((await db.invitation.findMany({ where: { workspaceId }, select: { id: true } })).map((r) => r.id));
    expect(invites.has(ids.inviteExpiredOld)).toBe(false);
    expect(invites.has(ids.inviteRevokedOld)).toBe(false);
    expect(invites.has(ids.inviteExpiredRecent)).toBe(true);
    expect(invites.has(ids.inviteRevokedRecent)).toBe(true);
    expect(invites.has(ids.inviteAcceptedOld)).toBe(true);
    expect(invites.has(ids.inviteLive)).toBe(true);

    expect(await db.emailOutbox.findUnique({ where: { id: ids.mailOld } })).toBeNull();
    expect(await db.emailOutbox.findUnique({ where: { id: ids.mailRecent } })).not.toBeNull();

    const notes = new Set((await db.notification.findMany({ where: { userId }, select: { id: true } })).map((r) => r.id));
    expect(notes.has(ids.noteReadOld)).toBe(false);
    expect(notes.has(ids.noteUnreadOld)).toBe(true);
    expect(notes.has(ids.noteReadRecent)).toBe(true);
  });

  it("is idempotent: a second run finds nothing more of ours", async () => {
    await runHousekeeping(NOW);
    expect(await db.authToken.count({ where: { userId } })).toBe(3);
    expect(await db.invitation.count({ where: { workspaceId } })).toBe(4);
    expect(await db.notification.count({ where: { userId } })).toBe(2);
  });
});
