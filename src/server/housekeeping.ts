import { db } from "@/lib/db";
import { purgeExpiredTrash, TRASH_RETENTION_DAYS, type TrashPurgeResult } from "@/server/trash";

/**
 * Daily cleanup of rows that can no longer be used (GET /api/cron/cleanup).
 *
 * Documented exception to the ctx-first rule: this is a system task with no
 * user or workspace; it never runs on behalf of a request. Every rule only
 * removes rows that stopped being usable long ago:
 *  - AuthToken: used, or expired, more than 7 days ago (unused live tokens stay).
 *  - Invitation: expired (never accepted) or revoked more than 30 days ago;
 *    accepted invitations are kept.
 *  - EmailOutbox: created more than 30 days ago.
 *  - Notification: read, and created more than 90 days ago (unread ones stay).
 *  - Trash: posts, to-dos, lists, events, files (and their stored objects),
 *    documents and folders trashed more than 30 days ago (see trash.ts).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION_DAYS = {
  authTokens: 7,
  invitations: 30,
  emailOutbox: 30,
  readNotifications: 90,
  trash: TRASH_RETENTION_DAYS,
} as const;

export type HousekeepingResult = {
  authTokens: number;
  invitations: number;
  emailOutbox: number;
  notifications: number;
  trash: TrashPurgeResult;
};

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

export async function runHousekeeping(now: Date = new Date()): Promise<HousekeepingResult> {
  const tokenCutoff = daysBefore(now, RETENTION_DAYS.authTokens);
  const inviteCutoff = daysBefore(now, RETENTION_DAYS.invitations);
  const outboxCutoff = daysBefore(now, RETENTION_DAYS.emailOutbox);
  const notificationCutoff = daysBefore(now, RETENTION_DAYS.readNotifications);

  // Independent statements (no transaction needed): each one is idempotent.
  const authTokens = await db.authToken.deleteMany({
    where: { OR: [{ usedAt: { lt: tokenCutoff } }, { expiresAt: { lt: tokenCutoff } }] },
  });
  const invitations = await db.invitation.deleteMany({
    where: {
      OR: [{ revokedAt: { lt: inviteCutoff } }, { acceptedAt: null, expiresAt: { lt: inviteCutoff } }],
    },
  });
  const emailOutbox = await db.emailOutbox.deleteMany({ where: { createdAt: { lt: outboxCutoff } } });
  const notifications = await db.notification.deleteMany({
    where: { readAt: { not: null }, createdAt: { lt: notificationCutoff } },
  });

  const trash = await purgeExpiredTrash(now);

  return {
    authTokens: authTokens.count,
    invitations: invitations.count,
    emailOutbox: emailOutbox.count,
    notifications: notifications.count,
    trash,
  };
}
