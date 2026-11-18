import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { MAX_MENTIONS, mentionsToPlain, parseMentionIds } from "@/lib/mentions";
import { canModify, clientVisibleWhere } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { forgetActivity, recordActivity } from "@/server/activity";
import { documentClientWhere } from "@/server/client-visibility";
import { forbidden, notFound, parseInput } from "@/server/errors";
import { visiblePostWhere } from "@/server/post-visibility";
import {
  notify,
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_TITLE_MAX,
  type NotificationType,
} from "@/server/notifications";
import { autoSubscribe, ensureSubscribers, listSubscriberIds } from "@/server/subscriptions";

/**
 * Comments on every kind of subject: message-board posts, to-dos, documents
 * and calendar events ("Yorumlar"), plus @mentions.
 *
 * Every call first loads the SUBJECT row scoped by ctx.workspaceId (NOT_FOUND
 * otherwise), so a comment can never be read from or attached to another
 * workspace's content. Writes set workspaceId from ctx and exactly one of the
 * four foreign keys (the DB also enforces that with a CHECK constraint).
 *
 * Permissions: any member comments; authors edit/delete their own comments;
 * ADMIN/OWNER anything. A GUEST can comment on (and read) the subjects it can
 * see, i.e. everything that is not internal ("Yalnızca ekip"): a to-do follows
 * its list, a document its own flag and folder.
 */

export const COMMENT_SUBJECT_TYPES = ["post", "todo", "document", "event"] as const;
export type CommentSubjectType = (typeof COMMENT_SUBJECT_TYPES)[number];
export type CommentSubject = { type: CommentSubjectType; id: string };

export const COMMENT_MAX = 5000;

const idSchema = z.string().min(1).max(64);

const subjectSchema = z.object({
  type: z.enum(COMMENT_SUBJECT_TYPES, { error: "Geçersiz yorum konusu." }),
  id: z.string({ error: "Kayıt bulunamadı." }).min(1, "Kayıt bulunamadı.").max(64, "Kayıt bulunamadı."),
});

const commentSchema = z.object({
  body: z
    .string({ error: "Yorum boş olamaz." })
    .trim()
    .min(1, "Yorum boş olamaz.")
    .max(COMMENT_MAX, "Yorum çok uzun (en fazla 5.000 karakter)."),
});

const authorSelect = { select: { id: true, name: true, email: true, image: true } } as const;

// ------------------------------------------------------------ subjects ----

/** Workspace-relative detail page of a subject (notifications, activity, search). */
export function commentSubjectPath(subject: CommentSubject): string {
  switch (subject.type) {
    case "post":
      return `messages/${subject.id}`;
    case "todo":
      return `todos/${subject.id}`;
    case "document":
      return `files/docs/${subject.id}`;
    case "event":
      return `calendar/${subject.id}`;
  }
}

/** The subject a stored comment row belongs to (null only for a row breaking the CHECK). */
export function commentSubjectOf(row: {
  postId: string | null;
  todoItemId: string | null;
  documentId: string | null;
  eventId: string | null;
}): CommentSubject | null {
  if (row.postId) return { type: "post", id: row.postId };
  if (row.todoItemId) return { type: "todo", id: row.todoItemId };
  if (row.documentId) return { type: "document", id: row.documentId };
  if (row.eventId) return { type: "event", id: row.eventId };
  return null;
}

/** The single foreign key a comment on `subject` sets / is filtered by. */
function subjectKey(subject: CommentSubject) {
  switch (subject.type) {
    case "post":
      return { postId: subject.id };
    case "todo":
      return { todoItemId: subject.id };
    case "document":
      return { documentId: subject.id };
    case "event":
      return { eventId: subject.id };
  }
}

function subjectKeyIn(type: CommentSubjectType, ids: string[]): Prisma.CommentWhereInput {
  switch (type) {
    case "post":
      return { postId: { in: ids } };
    case "todo":
      return { todoItemId: { in: ids } };
    case "document":
      return { documentId: { in: ids } };
    case "event":
      return { eventId: { in: ids } };
  }
}

type LoadedSubject = CommentSubject & {
  title: string;
  /** People who follow the subject: post/document author, to-do creator + assignee, event creator. */
  ownerIds: string[];
  /** True only for an unpublished post (draft): no activity or notifications may leak its title/body. */
  isDraft: boolean;
  /** Team-only subject: its notifications never go to guests. */
  internal: boolean;
};

const NOT_FOUND_MESSAGES: Record<CommentSubjectType, string> = {
  post: "Gönderi bulunamadı.",
  todo: "Görev bulunamadı.",
  document: "Doküman bulunamadı.",
  event: "Etkinlik bulunamadı.",
};

/** Turkish noun with the dative ("…na yorum yaptı") and locative ("…ndaki") case for titles. */
const SUBJECT_WORDS: Record<CommentSubjectType, { dative: string; locative: string }> = {
  post: { dative: "mesajına", locative: "mesajındaki" },
  todo: { dative: "görevine", locative: "görevindeki" },
  document: { dative: "dokümanına", locative: "dokümanındaki" },
  event: { dative: "etkinliğine", locative: "etkinliğindeki" },
};

/** Validate `input` and load the subject row inside ctx's workspace (NOT_FOUND otherwise). */
async function loadSubject(ctx: TenantContext, input: unknown): Promise<LoadedSubject> {
  const subject = parseInput(subjectSchema, input);
  const where = { id: subject.id, workspaceId: ctx.workspaceId, deletedAt: null };
  let found: LoadedSubject | null = null;
  switch (subject.type) {
    case "post": {
      const row = await db.post.findFirst({
        where: { ...where, ...visiblePostWhere(ctx) },
        select: { id: true, title: true, authorId: true, publishedAt: true, internal: true },
      });
      if (row) {
        found = {
          ...subject,
          title: row.title,
          ownerIds: [row.authorId],
          isDraft: row.publishedAt === null,
          internal: row.internal,
        };
      }
      break;
    }
    case "todo": {
      const row = await db.todoItem.findFirst({
        where: { ...where, list: { workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) } },
        select: { id: true, title: true, createdById: true, assigneeId: true, list: { select: { internal: true } } },
      });
      if (row) {
        const ids = [row.createdById, ...(row.assigneeId ? [row.assigneeId] : [])];
        found = { ...subject, title: row.title, ownerIds: ids, isDraft: false, internal: row.list.internal };
      }
      break;
    }
    case "document": {
      const row = await db.document.findFirst({
        where: { ...where, ...documentClientWhere(ctx) },
        select: { id: true, title: true, authorId: true, internal: true, folder: { select: { internal: true } } },
      });
      if (row) {
        const internal = row.internal || (row.folder?.internal ?? false);
        found = { ...subject, title: row.title, ownerIds: [row.authorId], isDraft: false, internal };
      }
      break;
    }
    case "event": {
      const row = await db.event.findFirst({
        where: { ...where, ...clientVisibleWhere(ctx) },
        select: { id: true, title: true, createdById: true, internal: true },
      });
      if (row) {
        found = { ...subject, title: row.title, ownerIds: [row.createdById], isDraft: false, internal: row.internal };
      }
      break;
    }
  }
  if (!found) throw notFound(NOT_FOUND_MESSAGES[subject.type]);
  return found;
}

// ------------------------------------------------------------ mentions ----

/**
 * Ids mentioned in `body` that are CURRENT members of ctx's workspace, in
 * order, capped at MAX_MENTIONS. Unknown / foreign ids are dropped.
 */
export async function resolveMentionedMembers(ctx: TenantContext, body: string): Promise<string[]> {
  const ids = parseMentionIds(body, MAX_MENTIONS);
  if (ids.length === 0) return [];
  const rows = await db.membership.findMany({
    where: { workspaceId: ctx.workspaceId, userId: { in: ids } },
    select: { userId: true },
  });
  const members = new Set(rows.map((r) => r.userId));
  return ids.filter((id) => members.has(id));
}

/** Hard cap on ids looked up for one page (many comments with many mentions). */
const MENTION_NAMES_MAX = 500;

/**
 * Display names (from the DB) for the members mentioned in `bodies`, keyed by
 * user id. Ids that are not current members of ctx's workspace are absent, so
 * the Markdown renderer shows them as plain text.
 */
export async function mentionNames(ctx: TenantContext, bodies: string[]): Promise<Record<string, string>> {
  const ids = new Set<string>();
  for (const body of bodies) {
    for (const id of parseMentionIds(body, MAX_MENTIONS)) {
      if (ids.size >= MENTION_NAMES_MAX) break;
      ids.add(id);
    }
  }
  if (ids.size === 0) return {};
  const rows = await db.membership.findMany({
    where: { workspaceId: ctx.workspaceId, userId: { in: [...ids] } },
    select: { user: { select: { id: true, name: true, email: true } } },
  });
  const names: Record<string, string> = {};
  for (const r of rows) names[r.user.id] = memberLabel(r.user);
  return names;
}

/** Members offered by the @ suggestion list (id + DB name), the caller excluded. */
export async function listMentionCandidates(
  ctx: TenantContext,
): Promise<Array<{ id: string; name: string; email: string; image: string | null }>> {
  const rows = await db.membership.findMany({
    where: { workspaceId: ctx.workspaceId, userId: { not: ctx.userId } },
    select: { user: { select: { id: true, name: true, email: true, image: true } } },
  });
  return rows
    .map((r) => ({ id: r.user.id, name: memberLabel(r.user), email: r.user.email, image: r.user.image }))
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));
}

function memberLabel(u: { name: string | null; email: string }): string {
  return clip(u.name?.trim() || u.email.split("@")[0] || "Üye", 80);
}

// ------------------------------------------------------- notifications ----

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

async function actorLabel(ctx: TenantContext): Promise<string> {
  const u = await db.user.findUnique({ where: { id: ctx.userId }, select: { name: true, email: true } });
  return clip(u?.name?.trim() || u?.email || "Bir üye", 80);
}

type DeliveredType = Extract<NotificationType, "POST_COMMENT" | "COMMENT" | "MENTION">;

/** notify() with the title and body clipped to its limits. Never throws. */
function deliver(
  ctx: TenantContext,
  input: {
    recipientIds: string[];
    type: DeliveredType;
    title: string;
    body?: string | null;
    path: string;
    internal?: boolean;
  },
): Promise<number> {
  return notify(ctx, {
    recipientIds: [...new Set(input.recipientIds)].slice(0, 5000),
    type: input.type,
    title: clip(input.title, NOTIFICATION_TITLE_MAX),
    body: input.body ? clip(input.body, NOTIFICATION_BODY_MAX) : null,
    path: input.path,
    internal: input.internal,
  });
}

/** MENTION notifications for `ids` (already resolved to members). Never throws. */
export async function notifyMentions(
  ctx: TenantContext,
  ids: string[],
  where: {
    title: string;
    path: string;
    body: string;
    kind: "post" | { comment: CommentSubjectType };
    /** Team-only subject: guests are not notified. */
    internal?: boolean;
  },
): Promise<number> {
  try {
    if (ids.length === 0) return 0;
    const actor = await actorLabel(ctx);
    const quoted = `“${clip(where.title, 80)}”`;
    const title =
      where.kind === "post"
        ? `${actor} ${quoted} mesajında sizden bahsetti`
        : `${actor} ${quoted} ${SUBJECT_WORDS[where.kind.comment].locative} bir yorumda sizden bahsetti`;
    const names = await mentionNames(ctx, [where.body]);
    return await deliver(ctx, {
      recipientIds: ids,
      type: "MENTION",
      title,
      body: clip(mentionsToPlain(where.body, names), 200),
      path: where.path,
      internal: where.internal,
    });
  } catch (e) {
    console.error("[comments] notifyMentions failed:", e);
    return 0;
  }
}

/**
 * A new comment: the item's subscribers (documents have no subscribers, so
 * they keep their author plus earlier commenters), minus the members mentioned
 * in this comment (they get a MENTION instead), then one MENTION per mentioned
 * member. The commenter and the mentioned members become subscribers.
 * Never throws.
 */
async function notifyNewComment(
  ctx: TenantContext,
  subject: LoadedSubject,
  comment: { id: string; body: string },
): Promise<void> {
  try {
    const path = commentSubjectPath(subject);
    const [actor, earlier, mentioned] = await Promise.all([
      actorLabel(ctx),
      db.comment.findMany({
        where: { workspaceId: ctx.workspaceId, ...subjectKey(subject), id: { not: comment.id } },
        select: { authorId: true },
        distinct: ["authorId"],
      }),
      resolveMentionedMembers(ctx, comment.body),
    ]);
    const mentionedSet = new Set(mentioned);
    let followers = [...subject.ownerIds, ...earlier.map((c) => c.authorId)];
    if (subject.type !== "document") {
      const sub = { type: subject.type, id: subject.id };
      // Items from before subscriptions existed: seed owners + earlier commenters once.
      await ensureSubscribers(ctx, sub, followers);
      await autoSubscribe(ctx, sub, [ctx.userId, ...mentioned]);
      followers = await listSubscriberIds(ctx, sub);
    }
    followers = followers.filter((id) => !mentionedSet.has(id));
    const names = await mentionNames(ctx, [comment.body]);
    await deliver(ctx, {
      recipientIds: followers,
      type: subject.type === "post" ? "POST_COMMENT" : "COMMENT",
      title: `${actor} “${clip(subject.title, 80)}” ${SUBJECT_WORDS[subject.type].dative} yorum yaptı`,
      body: clip(mentionsToPlain(comment.body, names), 200),
      path,
      internal: subject.internal,
    });
    await notifyMentions(ctx, mentioned, {
      title: subject.title,
      path,
      body: comment.body,
      kind: { comment: subject.type },
      internal: subject.internal,
    });
  } catch (e) {
    console.error("[comments] notifyNewComment failed:", e);
  }
}

// ------------------------------------------------------------- service ----

export type CommentDTO = {
  id: string;
  body: string;
  authorId: string;
  createdAt: Date;
  updatedAt: Date;
  author: { id: string; name: string | null; email: string; image: string | null };
};

/** A thread shows at most this many comments (the newest ones). */
export const COMMENTS_SHOWN_MAX = 200;

/**
 * The newest `take` (default COMMENTS_SHOWN_MAX) comments on `subject`,
 * returned oldest first. NOT_FOUND when the subject is not in ctx's workspace.
 */
export async function listComments(
  ctx: TenantContext,
  subject: CommentSubject,
  opts: { take?: number } = {},
): Promise<CommentDTO[]> {
  const take = Math.min(Math.max(opts.take ?? COMMENTS_SHOWN_MAX, 1), COMMENTS_SHOWN_MAX);
  const s = await loadSubject(ctx, subject);
  const rows = await db.comment.findMany({
    where: { workspaceId: ctx.workspaceId, ...subjectKey(s) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: { id: true, body: true, authorId: true, createdAt: true, updatedAt: true, author: authorSelect },
  });
  return rows.reverse();
}

const COUNT_COMMENTS_CHUNK = 500;
const COUNT_COMMENTS_MAX = 5000;

/**
 * Comment counts per subject id, in one grouped query per 500 ids (for list views).
 * Ids from other workspaces simply count 0.
 */
export async function countComments(
  ctx: TenantContext,
  type: CommentSubjectType,
  ids: string[],
): Promise<Record<string, number>> {
  const wanted = [...new Set(ids.filter((id) => typeof id === "string" && id.length <= 64))].slice(
    0,
    COUNT_COMMENTS_MAX,
  );
  const out: Record<string, number> = {};
  if (wanted.length === 0) return out;
  const kind = parseInput(subjectSchema.shape.type, type);
  // Exactly one key is set per row, so grouping by all four groups by subject.
  // One query per COUNT_COMMENTS_CHUNK ids (a to-do page can show more than
  // one chunk's worth; earlier, ids past the first 500 silently counted 0).
  const chunks: string[][] = [];
  for (let i = 0; i < wanted.length; i += COUNT_COMMENTS_CHUNK) chunks.push(wanted.slice(i, i + COUNT_COMMENTS_CHUNK));
  const groups = await Promise.all(
    chunks.map((chunk) =>
      db.comment.groupBy({
        by: ["postId", "todoItemId", "documentId", "eventId"],
        where: { workspaceId: ctx.workspaceId, ...subjectKeyIn(kind, chunk) },
        _count: { _all: true },
      }),
    ),
  );
  for (const r of groups.flat()) {
    const subject = commentSubjectOf(r);
    if (subject && subject.type === kind) out[subject.id] = (out[subject.id] ?? 0) + r._count._all;
  }
  return out;
}

export async function addComment(ctx: TenantContext, subject: CommentSubject, input: unknown) {
  const data = parseInput(commentSchema, input);
  const s = await loadSubject(ctx, subject);
  const comment = await db.comment.create({
    data: { body: data.body, workspaceId: ctx.workspaceId, authorId: ctx.userId, ...subjectKey(s) },
  });
  // A draft post is author-only; commenting on it must not broadcast its title
  // or body to the workspace (activity feed) or to anyone via notifications.
  if (!s.isDraft) {
    // After the main write; neither throws.
    await notifyNewComment(ctx, s, comment);
    await recordActivity(ctx, {
      type: "COMMENT_CREATED",
      title: s.title,
      path: commentSubjectPath(s),
      subject: { type: "comment", id: comment.id },
    });
  }
  return comment;
}

/** The comment (scoped by workspace) and its subject, re-verified to be in ctx's workspace. */
async function findComment(ctx: TenantContext, commentId: unknown) {
  const id = parseInput(idSchema, commentId);
  const c = await db.comment.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
  const subject = c ? commentSubjectOf(c) : null;
  if (!c || !subject) throw notFound("Yorum bulunamadı.");
  try {
    return { comment: c, subject: await loadSubject(ctx, subject) };
  } catch {
    throw notFound("Yorum bulunamadı.");
  }
}

/** Edit a comment. Only mentions that were not in the previous body are notified. */
export async function updateComment(
  ctx: TenantContext,
  commentId: string,
  input: unknown,
): Promise<{ subject: CommentSubject }> {
  const data = parseInput(commentSchema, input);
  const { comment, subject } = await findComment(ctx, commentId);
  if (!canModify(ctx, comment.authorId)) throw forbidden("Bu yorumu düzenleme yetkiniz yok.");
  const res = await db.comment.updateMany({
    where: { id: comment.id, workspaceId: ctx.workspaceId },
    data: { body: data.body },
  });
  if (res.count === 0) throw notFound("Yorum bulunamadı.");
  const before = new Set(parseMentionIds(comment.body, MAX_MENTIONS));
  const added = (await resolveMentionedMembers(ctx, data.body)).filter((id) => !before.has(id));
  // No mention notifications for a comment on an unpublished draft (author-only).
  if (!subject.isDraft) {
    await notifyMentions(ctx, added, {
      title: subject.title,
      path: commentSubjectPath(subject),
      body: data.body,
      kind: { comment: subject.type },
      internal: subject.internal,
    });
  }
  return { subject: { type: subject.type, id: subject.id } };
}

export async function deleteComment(ctx: TenantContext, commentId: string): Promise<{ subject: CommentSubject }> {
  const { comment, subject } = await findComment(ctx, commentId);
  if (!canModify(ctx, comment.authorId)) throw forbidden("Bu yorumu silme yetkiniz yok.");
  await db.$transaction(async (tx) => {
    await forgetActivity(ctx, [{ type: "comment", id: comment.id }], tx);
    await tx.reaction.deleteMany({
      where: { workspaceId: ctx.workspaceId, subjectType: "comment", subjectId: comment.id },
    });
    await tx.comment.deleteMany({ where: { id: comment.id, workspaceId: ctx.workspaceId } });
  });
  return { subject: { type: subject.type, id: subject.id } };
}
