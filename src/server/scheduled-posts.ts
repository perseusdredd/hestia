import { db } from "@/lib/db";
import { announcePost } from "@/server/messages";

/**
 * Publishes every scheduled post that is due (publishedAt null, scheduledFor
 * <= now, not deleted). The conditional updateMany is the gate: only the run
 * that flips publishedAt announces (notifications, activity, subscription), so
 * a concurrent or repeated run does nothing. Returns the number published.
 */
export async function publishDueScheduled(now: Date): Promise<number> {
  const due = await db.post.findMany({
    where: { publishedAt: null, deletedAt: null, scheduledFor: { not: null, lte: now } },
    select: { id: true, workspaceId: true, authorId: true },
    orderBy: { scheduledFor: "asc" },
    take: 200,
  });
  let published = 0;
  for (const row of due) {
    try {
      const res = await db.post.updateMany({
        where: { id: row.id, publishedAt: null, deletedAt: null, scheduledFor: { not: null, lte: now } },
        data: { publishedAt: now, createdAt: now, updatedAt: now, scheduledFor: null },
      });
      if (res.count === 0) continue; // someone else published / cancelled it
      published++;
      const [post, membership] = await Promise.all([
        db.post.findUniqueOrThrow({ where: { id: row.id } }),
        db.membership.findFirst({
          where: { workspaceId: row.workspaceId, userId: row.authorId },
          select: { role: true },
        }),
      ]);
      // If the author left the workspace the post is still published, announced as a member action.
      const ctx = { userId: row.authorId, workspaceId: row.workspaceId, role: membership?.role ?? "MEMBER" } as const;
      await announcePost(ctx, post);
    } catch (e) {
      console.error("[scheduled-posts] failed for", row.id, e);
    }
  }
  return published;
}
