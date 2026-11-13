import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { markdownExcerpt } from "@/lib/markdown-plain";
import { parseMentionIds } from "@/lib/mentions";
import { canModify, hasRole } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { forgetActivity, postActivityPath, recordActivity } from "@/server/activity";
import { forbidden, notFound, parseInput, ServiceError } from "@/server/errors";
import {
  addComment,
  deleteComment as deleteGenericComment,
  notifyMentions,
  resolveMentionedMembers,
  updateComment as updateGenericComment,
} from "@/server/comments";
import { notify } from "@/server/notifications";

const idSchema = z.string().min(1).max(64);

const postSchema = z.object({
  title: z.string().trim().min(1, "Başlık gerekli.").max(200, "Başlık en fazla 200 karakter olabilir."),
  body: z.string().trim().min(1, "Mesaj gerekli.").max(20000, "Mesaj çok uzun (en fazla 20.000 karakter)."),
});

const authorSelect = { select: { id: true, name: true, email: true, image: true } } as const;

export const POSTS_PAGE_SIZE = 20;

export type PostListItem = {
  id: string;
  title: string;
  excerpt: string;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
  author: { id: string; name: string | null; email: string; image: string | null };
  commentCount: number;
};


const cursorSchema = z.object({
  p: z.union([z.literal(0), z.literal(1)]), // 1 = last row of the previous page was pinned
  t: z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), "Geçersiz imleç."),
  i: z.string().min(1).max(64),
});

function encodeCursor(row: { pinned: boolean; createdAt: Date; id: string }): string {
  const payload = { p: row.pinned ? 1 : 0, t: row.createdAt.toISOString(), i: row.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string) {
  let raw: unknown;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("bad");
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ServiceError("VALIDATION", "Geçersiz sayfa imleci.", { cursor: ["Geçersiz sayfa imleci."] });
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceError("VALIDATION", "Geçersiz sayfa imleci.", { cursor: ["Geçersiz sayfa imleci."] });
  }
  return { pinned: parsed.data.p === 1, createdAt: new Date(parsed.data.t), id: parsed.data.i };
}

/**
 * Pinned first, then newest (createdAt desc, id desc). Keyset pagination: pass
 * the previous page's `nextCursor`. The cursor holds the last row's
 * (pinned, createdAt, id), so it continues correctly across the pinned/unpinned
 * boundary and is unaffected by posts created or pinned between loads.
 */
export async function listPosts(
  ctx: TenantContext,
  opts: { cursor?: string | null; take?: number } = {},
): Promise<{ items: PostListItem[]; hasMore: boolean; nextCursor: string | null }> {
  const take = Math.min(Math.max(opts.take ?? POSTS_PAGE_SIZE, 1), 50);
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const olderThan = after
    ? {
        OR: [
          { createdAt: { lt: after.createdAt } },
          { createdAt: after.createdAt, id: { lt: after.id } },
        ],
      }
    : null;
  const where: Prisma.PostWhereInput = { workspaceId: ctx.workspaceId };
  if (after && olderThan) {
    where.OR = after.pinned
      ? [{ pinned: true, ...olderThan }, { pinned: false }]
      : [{ pinned: false, ...olderThan }];
  }
  const rows = await db.post.findMany({
    where,
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: { author: authorSelect, _count: { select: { comments: true } } },
  });
  const hasMore = rows.length > take;
  const page = rows.slice(0, take);
  const items = page.map((p) => ({
    id: p.id,
    title: p.title,
    excerpt: markdownExcerpt(p.body),
    pinned: p.pinned,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    author: p.author,
    commentCount: p._count.comments,
  }));
  const last = page[page.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? encodeCursor(last) : null };
}

/**
 * The post and its author, without comments (the post page loads those via
 * CommentThread / listComments, capped). Throws NOT_FOUND for ids from other
 * workspaces.
 */
export async function getPostHeader(ctx: TenantContext, postId: string) {
  const id = parseInput(idSchema, postId);
  const post = await db.post.findFirst({
    where: { id, workspaceId: ctx.workspaceId },
    include: { author: authorSelect },
  });
  if (!post) throw notFound("Gönderi bulunamadı.");
  return post;
}

/** Post with ALL its comments (oldest first). Throws NOT_FOUND for ids from other workspaces. */
export async function getPost(ctx: TenantContext, postId: string) {
  const id = parseInput(idSchema, postId);
  const post = await db.post.findFirst({
    where: { id, workspaceId: ctx.workspaceId },
    include: {
      author: authorSelect,
      comments: {
        where: { workspaceId: ctx.workspaceId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { author: authorSelect },
      },
    },
  });
  if (!post) throw notFound("Gönderi bulunamadı.");
  return post;
}

export async function createPost(ctx: TenantContext, input: unknown) {
  const data = parseInput(postSchema, input);
  const post = await db.post.create({
    data: { ...data, workspaceId: ctx.workspaceId, authorId: ctx.userId },
  });
  await notifyNewPost(ctx, post); // after the main write; never throws
  await recordActivity(ctx, {
    type: "POST_CREATED",
    title: post.title,
    path: postActivityPath(post.id),
    subject: { type: "post", id: post.id },
  });
  return post;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * A new post: every other member gets POST_CREATED, except the members
 * mentioned in the body, who get one MENTION instead. Never throws.
 */
async function notifyNewPost(ctx: TenantContext, post: { id: string; title: string; body: string }) {
  try {
    const [actor, members, mentioned] = await Promise.all([
      db.user.findUnique({ where: { id: ctx.userId }, select: { name: true, email: true } }),
      db.membership.findMany({ where: { workspaceId: ctx.workspaceId }, select: { userId: true } }),
      resolveMentionedMembers(ctx, post.body),
    ]);
    const mentionedSet = new Set(mentioned);
    const label = clip(actor?.name?.trim() || actor?.email || "Bir üye", 80);
    await notify(ctx, {
      recipientIds: members.map((m) => m.userId).filter((id) => !mentionedSet.has(id)),
      type: "POST_CREATED",
      title: `${label} yeni bir mesaj paylaştı`,
      body: clip(post.title, 500),
      path: postActivityPath(post.id),
    });
    await notifyMentions(ctx, mentioned, {
      title: post.title,
      path: postActivityPath(post.id),
      body: post.body,
      kind: "post",
    });
  } catch (e) {
    console.error("[messages] notifyNewPost failed:", e);
  }
}

async function findPostInWorkspace(ctx: TenantContext, postId: string) {
  const id = parseInput(idSchema, postId);
  const post = await db.post.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
  if (!post) throw notFound("Gönderi bulunamadı.");
  return post;
}

export async function updatePost(ctx: TenantContext, postId: string, input: unknown) {
  const data = parseInput(postSchema, input);
  const post = await findPostInWorkspace(ctx, postId);
  if (!canModify(ctx, post.authorId)) throw forbidden("Bu gönderiyi düzenleme yetkiniz yok.");
  const res = await db.post.updateMany({
    where: { id: post.id, workspaceId: ctx.workspaceId },
    data,
  });
  if (res.count === 0) throw notFound("Gönderi bulunamadı.");
  // Only members who were not mentioned before are notified.
  const before = new Set(parseMentionIds(post.body));
  const added = (await resolveMentionedMembers(ctx, data.body)).filter((id) => !before.has(id));
  await notifyMentions(ctx, added, { title: data.title, path: postActivityPath(post.id), body: data.body, kind: "post" });
}

export async function deletePost(ctx: TenantContext, postId: string) {
  const post = await findPostInWorkspace(ctx, postId);
  if (!canModify(ctx, post.authorId)) throw forbidden("Bu gönderiyi silme yetkiniz yok.");
  await db.$transaction(async (tx) => {
    // Before the delete: the post's comments are found through their foreign key.
    await forgetActivity(ctx, [{ type: "post", id: post.id }], tx);
    await tx.post.deleteMany({ where: { id: post.id, workspaceId: ctx.workspaceId } });
  });
}

export async function setPostPinned(ctx: TenantContext, postId: string, pinned: boolean) {
  if (!hasRole(ctx.role, "ADMIN")) throw forbidden("Gönderileri yalnızca yöneticiler sabitleyebilir.");
  const post = await findPostInWorkspace(ctx, postId);
  // Pinning is not an edit: keep updatedAt (which drives "(düzenlendi)")
  // instead of letting @updatedAt bump it.
  const res = await db.post.updateMany({
    where: { id: post.id, workspaceId: ctx.workspaceId },
    data: { pinned, updatedAt: post.updatedAt },
  });
  if (res.count === 0) throw notFound("Gönderi bulunamadı.");
}

// ------------------------------------------------------------ comments ----
// Post comments go through the generic comment service (src/server/comments.ts).

export function createComment(ctx: TenantContext, postId: string, input: unknown) {
  return addComment(ctx, { type: "post", id: postId }, input);
}

export async function updateComment(ctx: TenantContext, commentId: string, input: unknown): Promise<void> {
  await updateGenericComment(ctx, commentId, input);
}

export async function deleteComment(ctx: TenantContext, commentId: string): Promise<void> {
  await deleteGenericComment(ctx, commentId);
}
