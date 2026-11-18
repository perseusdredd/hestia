import { z } from "zod";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";
import { notFound, parseInput } from "@/server/errors";
import { clientVisibleWhere } from "@/lib/roles";
import { documentClientWhere } from "@/server/client-visibility";
import { visiblePostWhere } from "@/server/post-visibility";

/**
 * Personal bookmarks ("Yer imlerim") for posts, to-dos, documents and events.
 *
 * The subject is polymorphic (no FK), so every write first loads it scoped by
 * ctx.workspaceId (NOT_FOUND otherwise) and the list re-loads each subject,
 * dropping trashed ones and drafts that are not the caller's own.
 */

export const BOOKMARK_SUBJECT_TYPES = ["post", "todo", "document", "event"] as const;
export type BookmarkSubjectType = (typeof BOOKMARK_SUBJECT_TYPES)[number];
export type BookmarkSubject = { type: BookmarkSubjectType; id: string };

const subjectSchema = z.object({
  type: z.enum(BOOKMARK_SUBJECT_TYPES, { error: "Geçersiz yer imi konusu." }),
  id: z.string({ error: "Kayıt bulunamadı." }).min(1, "Kayıt bulunamadı.").max(64, "Kayıt bulunamadı."),
});

async function requireSubject(ctx: TenantContext, input: unknown): Promise<BookmarkSubject> {
  const s = parseInput(subjectSchema, input);
  const where = { id: s.id, workspaceId: ctx.workspaceId, deletedAt: null };
  let found: { id: string } | null = null;
  switch (s.type) {
    case "post":
      found = await db.post.findFirst({ where: { ...where, ...visiblePostWhere(ctx) }, select: { id: true } });
      break;
    case "todo":
      found = await db.todoItem.findFirst({
        where: { ...where, list: { workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) } },
        select: { id: true },
      });
      break;
    case "document":
      found = await db.document.findFirst({ where: { ...where, ...documentClientWhere(ctx) }, select: { id: true } });
      break;
    case "event":
      found = await db.event.findFirst({ where: { ...where, ...clientVisibleWhere(ctx) }, select: { id: true } });
      break;
  }
  if (!found) throw notFound("Kayıt bulunamadı.");
  return s;
}

/** Is the caller bookmarking this subject? NOT_FOUND when it is not in ctx's workspace. */
export async function isBookmarked(ctx: TenantContext, subject: unknown): Promise<boolean> {
  const s = await requireSubject(ctx, subject);
  const row = await db.bookmark.findFirst({
    where: { userId: ctx.userId, workspaceId: ctx.workspaceId, subjectType: s.type, subjectId: s.id },
    select: { id: true },
  });
  return row !== null;
}

/** Add or remove the bookmark. `want` forces a state; omitted flips it. Returns the new state. */
export async function toggleBookmark(
  ctx: TenantContext,
  subject: unknown,
  want?: boolean,
): Promise<{ subject: BookmarkSubject; bookmarked: boolean }> {
  const s = await requireSubject(ctx, subject);
  const key = { userId: ctx.userId, workspaceId: ctx.workspaceId, subjectType: s.type, subjectId: s.id };
  const existing = await db.bookmark.findFirst({ where: key, select: { id: true } });
  const bookmarked = want ?? existing === null;
  if (bookmarked) {
    await db.bookmark.createMany({ data: [key], skipDuplicates: true });
  } else {
    await db.bookmark.deleteMany({ where: key });
  }
  return { subject: s, bookmarked };
}

export type BookmarkItem = {
  type: BookmarkSubjectType;
  id: string;
  title: string;
  /** Path under /w/[slug]. */
  path: string;
  createdAt: Date;
};

const MAX_BOOKMARKS = 200;

/** The caller's bookmarks, newest first; trashed, hidden-draft or vanished subjects are skipped. */
export async function listBookmarks(ctx: TenantContext): Promise<BookmarkItem[]> {
  const rows = await db.bookmark.findMany({
    where: { workspaceId: ctx.workspaceId, userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take: MAX_BOOKMARKS,
  });
  const idsOf = (t: BookmarkSubjectType) => rows.filter((r) => r.subjectType === t).map((r) => r.subjectId);
  const base = { workspaceId: ctx.workspaceId, deletedAt: null };
  const [posts, todos, documents, events] = await Promise.all([
    db.post.findMany({
      where: { ...base, id: { in: idsOf("post") }, ...visiblePostWhere(ctx) },
      select: { id: true, title: true },
    }),
    db.todoItem.findMany({
      where: {
        ...base,
        id: { in: idsOf("todo") },
        list: { workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
      },
      select: { id: true, title: true },
    }),
    db.document.findMany({
      where: { ...base, id: { in: idsOf("document") }, ...documentClientWhere(ctx) },
      select: { id: true, title: true },
    }),
    db.event.findMany({
      where: { ...base, id: { in: idsOf("event") }, ...clientVisibleWhere(ctx) },
      select: { id: true, title: true },
    }),
  ]);
  const found: Record<BookmarkSubjectType, Map<string, string>> = {
    post: new Map(posts.map((p) => [p.id, p.title])),
    todo: new Map(todos.map((t) => [t.id, t.title])),
    document: new Map(documents.map((d) => [d.id, d.title])),
    event: new Map(events.map((e) => [e.id, e.title])),
  };
  const paths: Record<BookmarkSubjectType, (id: string) => string> = {
    post: (id) => `messages/${id}`,
    todo: (id) => `todos/${id}`,
    document: (id) => `files/docs/${id}`,
    event: (id) => `calendar/${id}`,
  };
  const out: BookmarkItem[] = [];
  for (const r of rows) {
    const type = r.subjectType as BookmarkSubjectType;
    const title = found[type]?.get(r.subjectId);
    if (title === undefined) continue;
    out.push({ type, id: r.subjectId, title, path: paths[type](r.subjectId), createdAt: r.createdAt });
  }
  return out;
}
