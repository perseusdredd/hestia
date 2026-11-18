import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { istanbulDayKey } from "@/lib/istanbul-time";
import { isGuest, ROLE_LABELS, type Role } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { parseInput, ServiceError } from "@/server/errors";
import { isValidNotificationPath } from "@/server/notifications";

/**
 * Workspace activity feed ("Hareket akışı").
 *
 * Writing: recordActivity() and the recordX() helpers are called by other
 * services AFTER their main write has committed. They never throw: a failure
 * is logged and swallowed so it can never fail the user's action. A row is
 * only written when ctx.userId is CURRENTLY a member of ctx.workspaceId
 * (checked in the DB), so a stale ctx cannot write into a workspace the user
 * has left. The single exception is the "member left" row, which is written
 * after the membership is gone (see recordMembershipRemoved).
 *
 * Reading: listActivity() is scoped by ctx.workspaceId; every member sees the
 * whole workspace feed. A GUEST only gets rows whose subject is not internal
 * ("Yalnızca ekip") and none of the member rows. Activity.internal is derived
 * from the subject when the row is written (see subjectInternal) and kept in
 * sync when the flag changes (see syncActivityInternal).
 */

export const ACTIVITY_TYPES = [
  "POST_CREATED",
  "COMMENT_CREATED",
  "TODO_LIST_CREATED",
  "TODO_CREATED",
  "TODO_COMPLETED",
  "TODO_REOPENED",
  "EVENT_CREATED",
  "EVENT_UPDATED",
  "FILE_UPLOADED",
  "DOCUMENT_CREATED",
  "DOCUMENT_UPDATED",
  "FOLDER_CREATED",
  "ITEM_RESTORED",
  "HILL_UPDATED",
  "MEMBER_JOINED",
  "MEMBER_REMOVED",
  "MEMBER_LEFT",
  "MEMBER_ROLE_CHANGED",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Filter groups shown on the feed page. */
export const ACTIVITY_GROUPS = {
  messages: ["POST_CREATED", "COMMENT_CREATED"],
  todos: ["TODO_LIST_CREATED", "TODO_CREATED", "TODO_COMPLETED", "TODO_REOPENED", "HILL_UPDATED"],
  calendar: ["EVENT_CREATED", "EVENT_UPDATED"],
  files: ["FILE_UPLOADED", "DOCUMENT_CREATED", "DOCUMENT_UPDATED", "FOLDER_CREATED"],
  trash: ["ITEM_RESTORED"],
  members: ["MEMBER_JOINED", "MEMBER_REMOVED", "MEMBER_LEFT", "MEMBER_ROLE_CHANGED"],
} as const satisfies Record<string, readonly ActivityType[]>;
export type ActivityGroup = keyof typeof ACTIVITY_GROUPS;
export const ACTIVITY_GROUP_KEYS = Object.keys(ACTIVITY_GROUPS) as ActivityGroup[];

/**
 * What a feed row is about, stored in Activity.subjectType / subjectId so the
 * row can be removed when that content is deleted (see forgetActivity).
 */
export const ACTIVITY_SUBJECT_TYPES = [
  "post",
  "comment",
  "todoList",
  "todoItem",
  "event",
  "file",
  "document",
  "folder",
] as const;
export type ActivitySubjectType = (typeof ACTIVITY_SUBJECT_TYPES)[number];
export type ActivitySubject = { type: ActivitySubjectType; id: string };

export function isActivityGroup(value: unknown): value is ActivityGroup {
  return typeof value === "string" && Object.hasOwn(ACTIVITY_GROUPS, value);
}

export const ACTIVITY_TITLE_MAX = 200;
export const ACTIVITY_PAGE_SIZE = 30;
const ACTIVITY_TAKE_MAX = 100;
export const DELETED_USER_LABEL = "Silinmiş kullanıcı";

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const recordSchema = z.object({
  type: z.enum(ACTIVITY_TYPES),
  title: z
    .string()
    .max(10_000)
    .transform((t) => clip(t, ACTIVITY_TITLE_MAX))
    .pipe(z.string().min(1)),
  path: z.string().refine(isValidNotificationPath, "Geçersiz hareket yolu."),
  /** Omitted only for rows about members (they are never "deleted content"). */
  subject: z
    .object({ type: z.enum(ACTIVITY_SUBJECT_TYPES), id: z.string().min(1).max(64) })
    .optional(),
});

export type RecordActivityInput = z.input<typeof recordSchema>;

function logFailure(where: string, e: unknown) {
  console.error(`[activity] ${where} failed:`, e);
}

type CommentParentRow = {
  postId: string | null;
  todoItemId: string | null;
  documentId: string | null;
  eventId: string | null;
};

/** True when a document is hidden from guests: its own flag or its folder's. */
function documentIsInternal(d: { internal: boolean; folder: { internal: boolean } | null }): boolean {
  return d.internal || (d.folder?.internal ?? false);
}

/**
 * Whether content is team-only ("Yalnızca ekip"), looked up from the DB:
 * a to-do item follows its list, a file its folder (chat photos are always
 * team-only), a document its own flag or its folder's, a comment its parent.
 * Missing rows count as not internal.
 */
export async function subjectInternal(workspaceId: string, subject: ActivitySubject): Promise<boolean> {
  const where = { id: subject.id, workspaceId };
  switch (subject.type) {
    case "post":
      return (await db.post.findFirst({ where, select: { internal: true } }))?.internal ?? false;
    case "todoList":
      return (await db.todoList.findFirst({ where, select: { internal: true } }))?.internal ?? false;
    case "todoItem":
      return (await db.todoItem.findFirst({ where, select: { list: { select: { internal: true } } } }))?.list.internal ?? false;
    case "event":
      return (await db.event.findFirst({ where, select: { internal: true } }))?.internal ?? false;
    case "folder":
      return (await db.folder.findFirst({ where, select: { internal: true } }))?.internal ?? false;
    case "file": {
      const f = await db.file.findFirst({ where, select: { fromChat: true, folder: { select: { internal: true } } } });
      return f ? f.fromChat || (f.folder?.internal ?? false) : false;
    }
    case "document": {
      const d = await db.document.findFirst({ where, select: { internal: true, folder: { select: { internal: true } } } });
      return d ? documentIsInternal(d) : false;
    }
    case "comment": {
      const c: CommentParentRow | null = await db.comment.findFirst({
        where,
        select: { postId: true, todoItemId: true, documentId: true, eventId: true },
      });
      if (!c) return false;
      if (c.postId) return subjectInternal(workspaceId, { type: "post", id: c.postId });
      if (c.todoItemId) return subjectInternal(workspaceId, { type: "todoItem", id: c.todoItemId });
      if (c.documentId) return subjectInternal(workspaceId, { type: "document", id: c.documentId });
      if (c.eventId) return subjectInternal(workspaceId, { type: "event", id: c.eventId });
      return false;
    }
  }
}

async function markSubjects(workspaceId: string, type: ActivitySubjectType, ids: string[], internal: boolean) {
  if (ids.length === 0) return;
  await db.activity.updateMany({ where: { workspaceId, subjectType: type, subjectId: { in: ids } }, data: { internal } });
}

/**
 * Re-derive Activity.internal for `subject` and everything that inherits from
 * it, after its team-only flag changed or it moved into / out of a folder.
 * Never throws.
 */
export async function syncActivityInternal(ctx: Pick<TenantContext, "workspaceId">, subject: ActivitySubject): Promise<void> {
  try {
    const workspaceId = ctx.workspaceId;
    const { id } = subject;
    const commentsOf = async (key: keyof CommentParentRow, ids: string[], internal: boolean) => {
      if (ids.length === 0) return;
      const rows = await db.comment.findMany({ where: { workspaceId, [key]: { in: ids } }, select: { id: true } });
      await markSubjects(workspaceId, "comment", rows.map((r) => r.id), internal);
    };
    switch (subject.type) {
      case "post":
      case "event":
      case "document": {
        const internal = await subjectInternal(workspaceId, subject);
        await markSubjects(workspaceId, subject.type, [id], internal);
        await commentsOf(subject.type === "post" ? "postId" : subject.type === "event" ? "eventId" : "documentId", [id], internal);
        return;
      }
      case "todoList": {
        const internal = await subjectInternal(workspaceId, subject);
        await markSubjects(workspaceId, "todoList", [id], internal);
        const items = await db.todoItem.findMany({ where: { workspaceId, listId: id }, select: { id: true } });
        const itemIds = items.map((i) => i.id);
        await markSubjects(workspaceId, "todoItem", itemIds, internal);
        await commentsOf("todoItemId", itemIds, internal);
        return;
      }
      case "todoItem":
      case "file":
      case "comment": {
        await markSubjects(workspaceId, subject.type, [id], await subjectInternal(workspaceId, subject));
        return;
      }
      case "folder": {
        // The folder and its whole subtree: folders, their files and documents, and document comments.
        const folderIds = [id];
        for (let i = 0; i < folderIds.length && folderIds.length < 5000; i++) {
          const kids = await db.folder.findMany({ where: { workspaceId, parentId: folderIds[i] }, select: { id: true } });
          for (const k of kids) if (!folderIds.includes(k.id)) folderIds.push(k.id);
        }
        const folders = await db.folder.findMany({ where: { workspaceId, id: { in: folderIds } }, select: { id: true, internal: true } });
        await markSubjects(workspaceId, "folder", folders.filter((f) => f.internal).map((f) => f.id), true);
        await markSubjects(workspaceId, "folder", folders.filter((f) => !f.internal).map((f) => f.id), false);
        const internalFolders = new Set(folders.filter((f) => f.internal).map((f) => f.id));
        const files = await db.file.findMany({ where: { workspaceId, folderId: { in: folderIds } }, select: { id: true, folderId: true, fromChat: true } });
        const fileInternal = (f: (typeof files)[number]) => f.fromChat || (f.folderId !== null && internalFolders.has(f.folderId));
        await markSubjects(workspaceId, "file", files.filter(fileInternal).map((f) => f.id), true);
        await markSubjects(workspaceId, "file", files.filter((f) => !fileInternal(f)).map((f) => f.id), false);
        const docs = await db.document.findMany({ where: { workspaceId, folderId: { in: folderIds } }, select: { id: true, folderId: true, internal: true } });
        const docInternal = (d: (typeof docs)[number]) => d.internal || (d.folderId !== null && internalFolders.has(d.folderId));
        const yes = docs.filter(docInternal).map((d) => d.id);
        const no = docs.filter((d) => !docInternal(d)).map((d) => d.id);
        await markSubjects(workspaceId, "document", yes, true);
        await markSubjects(workspaceId, "document", no, false);
        await commentsOf("documentId", yes, true);
        await commentsOf("documentId", no, false);
        return;
      }
    }
  } catch (e) {
    logFailure("syncActivityInternal", e);
  }
}

async function insert(
  ctx: TenantContext,
  input: RecordActivityInput,
  opts: { requireMember: boolean },
): Promise<boolean> {
  const data = parseInput(recordSchema, input);
  if (opts.requireMember) {
    const member = await db.membership.findUnique({
      where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
      select: { id: true },
    });
    if (!member) return false;
  }
  await db.activity.create({
    data: {
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId,
      type: data.type,
      title: data.title,
      path: data.path,
      subjectType: data.subject?.type ?? null,
      subjectId: data.subject?.id ?? null,
      internal: data.subject ? await subjectInternal(ctx.workspaceId, data.subject) : false,
    },
  });
  return true;
}

/**
 * Append one activity row for ctx's workspace with ctx.userId as actor.
 * Returns true when a row was written. Never throws.
 */
export async function recordActivity(ctx: TenantContext, input: RecordActivityInput): Promise<boolean> {
  try {
    return await insert(ctx, input, { requireMember: true });
  } catch (e) {
    logFailure("recordActivity", e);
    return false;
  }
}

/** Run a helper; any failure (including lookups) is logged and swallowed. */
async function safely(where: string, fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await fn();
  } catch (e) {
    logFailure(where, e);
    return false;
  }
}

async function userLabel(userId: string): Promise<string> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  if (!u) return DELETED_USER_LABEL;
  return clip(u.name?.trim() || u.email.split("@")[0] || "Bir üye", 80);
}

// ------------------------------------------------------------- paths ----

/** Same link the event notification uses: the agenda day in the right month. */
export function eventActivityPath(event: { startsAt: Date }): string {
  const dayKey = istanbulDayKey(event.startsAt);
  return `calendar?month=${dayKey.slice(0, 7)}#agenda-${dayKey}`;
}

export function folderActivityPath(folderId: string | null): string {
  return folderId ? `files/${folderId}` : "files";
}

export function postActivityPath(postId: string): string {
  return `messages/${postId}`;
}

export function documentActivityPath(documentId: string): string {
  return `files/docs/${documentId}`;
}

/**
 * Paths that rows written before Activity had subject columns used for a
 * subject (rows of comments carried their parent's path, so they match too).
 */
function legacyPath(subject: ActivitySubject): string | null {
  switch (subject.type) {
    case "post":
      return postActivityPath(subject.id);
    case "document":
      return documentActivityPath(subject.id);
    case "folder":
      return folderActivityPath(subject.id);
    case "todoItem":
      return `todos/${subject.id}`;
    case "event":
      return `calendar/${subject.id}`;
    default:
      return null;
  }
}

const COMMENT_PARENT_KEYS = {
  post: "postId",
  todoItem: "todoItemId",
  document: "documentId",
  event: "eventId",
} as const satisfies Partial<Record<ActivitySubjectType, string>>;

/**
 * Drop the feed rows about deleted content, so its title does not stay
 * readable (also to members who join later). Matches rows by subject, plus
 * the rows of what goes with it: the items of a to-do list and the comments on
 * a post, to-do, document or event. Rows written before subjects existed are
 * matched by path where the path carries the id.
 *
 * Call it BEFORE deleting the content, in the same transaction: the items and
 * comments are looked up through their (cascading) foreign keys.
 */
export async function forgetActivity(
  ctx: Pick<TenantContext, "workspaceId">,
  subjects: ActivitySubject[],
  client: Prisma.TransactionClient = db,
): Promise<number> {
  if (subjects.length === 0) return 0;
  const byType = new Map<ActivitySubjectType, Set<string>>();
  const add = (type: ActivitySubjectType, id: string) => {
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type)!.add(id);
  };
  for (const s of subjects) add(s.type, s.id);

  const listIds = [...(byType.get("todoList") ?? [])];
  if (listIds.length) {
    const items = await client.todoItem.findMany({
      where: { workspaceId: ctx.workspaceId, listId: { in: listIds } },
      select: { id: true },
    });
    for (const i of items) add("todoItem", i.id);
  }

  const parents: Prisma.CommentWhereInput[] = [];
  for (const [type, key] of Object.entries(COMMENT_PARENT_KEYS) as [keyof typeof COMMENT_PARENT_KEYS, string][]) {
    const ids = [...(byType.get(type) ?? [])];
    if (ids.length) parents.push({ [key]: { in: ids } });
  }
  if (parents.length) {
    const comments = await client.comment.findMany({
      where: { workspaceId: ctx.workspaceId, OR: parents },
      select: { id: true },
    });
    for (const c of comments) add("comment", c.id);
  }

  const paths: string[] = [];
  const or: Prisma.ActivityWhereInput[] = [];
  for (const [type, ids] of byType) {
    or.push({ subjectType: type, subjectId: { in: [...ids] } });
    for (const id of ids) {
      const p = legacyPath({ type, id });
      if (p) paths.push(p);
    }
  }
  if (paths.length) or.push({ subjectType: null, path: { in: paths } });
  const { count } = await client.activity.deleteMany({ where: { workspaceId: ctx.workspaceId, OR: or } });
  return count;
}

// ----------------------------------------------------------- helpers ----

/** A to-do was marked done / reopened (looks the title up in ctx's workspace). */
export function recordTodoToggled(ctx: TenantContext, itemId: string, done: boolean): Promise<boolean> {
  return safely("recordTodoToggled", async () => {
    const item = await db.todoItem.findFirst({
      where: { id: itemId, workspaceId: ctx.workspaceId, deletedAt: null },
      select: { title: true },
    });
    if (!item) return false;
    return recordActivity(ctx, {
      type: done ? "TODO_COMPLETED" : "TODO_REOPENED",
      title: item.title,
      path: "todos",
      subject: { type: "todoItem", id: itemId },
    });
  });
}

/** ctx.userId just joined the workspace. */
export function recordMemberJoined(ctx: TenantContext): Promise<boolean> {
  return safely("recordMemberJoined", async () =>
    recordActivity(ctx, { type: "MEMBER_JOINED", title: await userLabel(ctx.userId), path: "settings" }),
  );
}

/** ctx changed `target`'s role to `target.role`. */
export function recordRoleChanged(ctx: TenantContext, target: { userId: string; role: Role }): Promise<boolean> {
  return safely("recordRoleChanged", async () =>
    recordActivity(ctx, {
      type: "MEMBER_ROLE_CHANGED",
      title: `${await userLabel(target.userId)} → ${ROLE_LABELS[target.role]}`,
      path: "settings",
    }),
  );
}

/**
 * A membership was removed by ctx. When ctx removed itself it LEFT: that row
 * is written although ctx.userId is no longer a member, but only when the DB
 * agrees the membership is gone (it then only states a fact about ctx.userId).
 */
export function recordMembershipRemoved(ctx: TenantContext, removedUserId: string): Promise<boolean> {
  return safely("recordMembershipRemoved", async () => {
    const name = await userLabel(removedUserId);
    if (removedUserId !== ctx.userId) {
      return recordActivity(ctx, { type: "MEMBER_REMOVED", title: name, path: "settings" });
    }
    const still = await db.membership.findUnique({
      where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
      select: { id: true },
    });
    if (still) return false;
    return insert(ctx, { type: "MEMBER_LEFT", title: name, path: "settings" }, { requireMember: false });
  });
}

// ------------------------------------------------------------- reading ----

export type ActivityActor = { id: string; name: string | null; email: string; image: string | null };

export type ActivityDTO = {
  id: string;
  type: string;
  title: string;
  /** Workspace-relative and validated; null when the stored path is unusable. */
  path: string | null;
  createdAt: Date;
  /** null when the actor's account was deleted. */
  actor: ActivityActor | null;
};

const cursorSchema = z.object({ t: z.string().datetime(), i: z.string().min(1).max(64) });

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.createdAt.toISOString(), i: row.id })).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const invalid = () =>
    new ServiceError("VALIDATION", "Geçersiz sayfa imleci.", { cursor: ["Geçersiz sayfa imleci."] });
  if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  return { createdAt: new Date(parsed.data.t), id: parsed.data.i };
}

const listSchema = z.object({
  cursor: z.string().max(256).nullish(),
  take: z.number().int().min(1).max(ACTIVITY_TAKE_MAX).optional(),
  types: z.array(z.enum(ACTIVITY_TYPES)).max(ACTIVITY_TYPES.length).nullish(),
  actorId: z.string().trim().min(1).max(64).nullish(),
});

export type ListActivityInput = z.input<typeof listSchema>;

/** The workspace feed, newest first, keyset-paginated on (createdAt, id). */
export async function listActivity(
  ctx: TenantContext,
  input: ListActivityInput = {},
): Promise<{ items: ActivityDTO[]; hasMore: boolean; nextCursor: string | null }> {
  const opts = parseInput(listSchema, input);
  const take = opts.take ?? ACTIVITY_PAGE_SIZE;
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const where: Prisma.ActivityWhereInput = {
    workspaceId: ctx.workspaceId,
    // A guest never sees team-only content or what happens to the team's membership.
    ...(isGuest(ctx.role) ? { internal: false, NOT: { type: { in: [...ACTIVITY_GROUPS.members] } } } : {}),
    ...(opts.types && opts.types.length ? { type: { in: opts.types } } : {}),
    ...(opts.actorId ? { actorId: opts.actorId } : {}),
    ...(after
      ? {
          OR: [
            { createdAt: { lt: after.createdAt } },
            { createdAt: after.createdAt, id: { lt: after.id } },
          ],
        }
      : {}),
  };
  const rows = await db.activity.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: { actor: { select: { id: true, name: true, email: true, image: true } } },
  });
  const hasMore = rows.length > take;
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      path: isValidNotificationPath(r.path) ? r.path : null,
      createdAt: r.createdAt,
      actor: r.actor,
    })),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}
