import { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { istanbulDayKey } from "@/lib/istanbul-time";
import { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH } from "@/lib/search-limits";
import { clientVisibleWhere } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { mentionsToPlain } from "@/lib/mentions";
import {
  commentSubjectPath,
  type CommentSubject,
  type CommentSubjectType,
} from "@/server/comments";
import { documentClientWhere, fileClientWhere } from "@/server/client-visibility";
import { parseInput } from "@/server/errors";
import { visiblePostWhere } from "@/server/post-visibility";

/**
 * Workspace search. Every query below is scoped by ctx.workspaceId. A GUEST
 * only finds what it could open: nothing marked internal ("Yalnızca ekip").
 *
 * Matching: Prisma `contains` + `mode: "insensitive"` compiles to Postgres
 * `ILIKE '%' || value || '%'` and does NOT escape LIKE metacharacters in the
 * value (Prisma 6, verified by tests/search.test.ts): "50%" would match
 * "50 indirim". escapeLike() backslash-escapes `\`, `%` and `_` (backslash is
 * Postgres' default LIKE escape character) so user input matches literally.
 *
 * Turkish letters: ILIKE folds Ç/ç, Ğ/ğ, Ö/ö, Ş/ş, Ü/ü and İ/i, but not I/ı
 * (lower("I") is "i"). We therefore also search the dotted/dotless variants of
 * the query (all ı -> i, all i/İ -> ı) so "ışık" finds "IŞIK". A query that
 * mixes I and ı in one word against stored text with the opposite mix can
 * still miss; fixing that fully needs a normalized column or unaccent-style
 * SQL function.
 */

export const SEARCH_TYPES = [
  "post",
  "comment",
  "todo",
  "list",
  "document",
  "file",
  "folder",
  "event",
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH };
export const DEFAULT_LIMIT_PER_TYPE = 5;
export const MAX_LIMIT_PER_TYPE = 50;
const SNIPPET_LENGTH = 160;

const searchInputSchema = z.object({
  q: z
    .string({ error: "Arama metni gerekli." })
    .trim()
    .min(SEARCH_MIN_LENGTH, `En az ${SEARCH_MIN_LENGTH} karakter yazın.`)
    .max(SEARCH_MAX_LENGTH, `Arama en fazla ${SEARCH_MAX_LENGTH} karakter olabilir.`),
  types: z
    .array(z.enum(SEARCH_TYPES, { error: "Geçersiz arama türü." }))
    .optional()
    .transform((v) => (v && v.length ? [...new Set(v)] : [...SEARCH_TYPES])),
  limitPerType: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT_PER_TYPE)
    .default(DEFAULT_LIMIT_PER_TYPE),
});

export type SearchInput = z.input<typeof searchInputSchema>;

/** Text plus [start, end) ranges of every match, for safe highlighting in React. */
export type HighlightedText = { text: string; ranges: Array<[number, number]> };

export type SearchAuthor = { id: string; name: string | null; email: string; image: string | null };

export type SearchResult = {
  type: SearchType;
  id: string;
  title: HighlightedText;
  snippet: HighlightedText | null;
  /** Extra context, e.g. the list of a to-do or the post of a comment. */
  context: string | null;
  author: SearchAuthor | null;
  date: Date;
  dateKind: "created" | "updated" | "starts";
  /** Workspace-relative path (no leading slash), e.g. "messages/<postId>". */
  path: string;
  /** Files only: download id and metadata. */
  file?: { id: string; mimeType: string; size: number };
};

export type SearchGroup = { type: SearchType; items: SearchResult[]; hasMore: boolean };

export type SearchResponse = { q: string; groups: SearchGroup[]; total: number };

// ------------------------------------------------------------ Matching ----

const I_FAMILY = /[Iİıi]/;

/** One-char-to-one-char case fold that treats I, İ, ı and i as equal. */
function foldChar(ch: string): string {
  if (I_FAMILY.test(ch)) return "i";
  const lower = ch.toLowerCase();
  return lower.length === ch.length ? lower : ch;
}

function fold(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) out += foldChar(text[i]);
  return out;
}

/** Query variants sent to the DB so the I/ı pairs match in both directions. */
export function queryVariants(q: string): string[] {
  // Postgres ILIKE folds "I" to "i", so uppercase I must also be tried as "ı"
  // ("IŞIK" / "Işık" find stored "ışık").
  const variants = new Set([q, q.replace(/ı/g, "i"), q.replace(/[iİI]/g, "ı")]);
  return [...variants];
}

/** All non-overlapping match ranges of `q` in `text` (Turkish-aware fold). */
export function findMatches(text: string, q: string): Array<[number, number]> {
  const needle = fold(q);
  if (!needle) return [];
  const hay = fold(text);
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    ranges.push([at, at + needle.length]);
    from = at + needle.length;
  }
  return ranges;
}

export function highlight(text: string, q: string): HighlightedText {
  return { text, ranges: findMatches(text, q) };
}

/** A short single-line excerpt around the first match (or the start of the text). */
export function makeSnippet(
  raw: string | null | undefined,
  q: string,
  length = SNIPPET_LENGTH,
): HighlightedText | null {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const first = findMatches(text, q)[0];
  let start = 0;
  if (first && first[1] > length) {
    start = Math.max(0, first[0] - Math.floor(length / 3));
    // Do not cut a word in half at the start.
    const space = text.lastIndexOf(" ", start);
    if (space !== -1 && start - space < 20) start = space + 1;
  }
  let end = Math.min(text.length, start + length);
  if (end < text.length) {
    const space = text.indexOf(" ", end);
    if (space !== -1 && space - end < 20) end = space;
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const excerpt = `${prefix}${text.slice(start, end)}${suffix}`;
  return highlight(excerpt, q);
}

/** Escape LIKE metacharacters so they match literally (default escape char is `\`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** OR of `field ILIKE %variant%` for every field and query variant. */
function anyFieldContains<W>(fields: string[], variants: string[]): W[] {
  const out: W[] = [];
  for (const field of fields) {
    for (const v of variants) {
      out.push({ [field]: { contains: v, mode: Prisma.QueryMode.insensitive } } as W);
    }
  }
  return out;
}

const authorSelect = { select: { id: true, name: true, email: true, image: true } } as const;

const COMMENT_SUBJECT_LABELS: Record<CommentSubjectType, string> = {
  post: "Mesaj",
  todo: "Görev",
  document: "Doküman",
  event: "Etkinlik",
  file: "Dosya",
};

type SubjectRef = { id: string; title: string; workspaceId: string } | null;

/** The comment's subject (only when it is in `workspaceId`), with its title. */
function commentSearchSubject(
  r: { post: SubjectRef; todoItem: SubjectRef; document: SubjectRef; event: SubjectRef; file: { id: string; name: string; workspaceId: string } | null },
  workspaceId: string,
): (CommentSubject & { title: string }) | null {
  const pick = (type: CommentSubjectType, ref: SubjectRef) =>
    ref && ref.workspaceId === workspaceId ? { type, id: ref.id, title: ref.title } : null;
  const file = r.file ? { id: r.file.id, title: r.file.name, workspaceId: r.file.workspaceId } : null;
  return (
    pick("post", r.post) ??
    pick("todo", r.todoItem) ??
    pick("document", r.document) ??
    pick("event", r.event) ??
    pick("file", file)
  );
}

// ------------------------------------------------------------- Service ----

export async function searchWorkspace(
  ctx: TenantContext,
  input: SearchInput,
): Promise<SearchResponse> {
  const { q, types, limitPerType } = parseInput(searchInputSchema, input);
  const variants = queryVariants(q).map(escapeLike);
  const take = limitPerType + 1;
  const workspaceId = ctx.workspaceId;

  const runners: Record<SearchType, () => Promise<SearchResult[]>> = {
    post: async () => {
      const rows = await db.post.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          AND: [visiblePostWhere(ctx)],
          OR: anyFieldContains<Prisma.PostWhereInput>(["title", "body"], variants),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: { id: true, title: true, body: true, createdAt: true, author: authorSelect },
      });
      return rows.map((r) => ({
        type: "post",
        id: r.id,
        title: highlight(r.title, q),
        snippet: makeSnippet(r.body, q),
        context: null,
        author: r.author,
        date: r.createdAt,
        dateKind: "created",
        path: `messages/${r.id}`,
      }));
    },

    comment: async () => {
      const rows = await db.comment.findMany({
        where: {
          workspaceId,
          AND: [
            // The subject (whichever of the four it is) must be in the same workspace too.
            {
              OR: [
                { post: { workspaceId, deletedAt: null, ...visiblePostWhere(ctx) } },
                { todoItem: { workspaceId, deletedAt: null, list: { deletedAt: null, ...clientVisibleWhere(ctx) } } },
                { document: { workspaceId, deletedAt: null, ...documentClientWhere(ctx) } },
                { event: { workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) } },
                { file: { workspaceId, deletedAt: null, ...fileClientWhere(ctx) } },
              ],
            },
            { OR: anyFieldContains<Prisma.CommentWhereInput>(["body"], variants) },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: {
          id: true,
          body: true,
          createdAt: true,
          author: authorSelect,
          post: { select: { id: true, title: true, workspaceId: true } },
          todoItem: { select: { id: true, title: true, workspaceId: true } },
          document: { select: { id: true, title: true, workspaceId: true } },
          event: { select: { id: true, title: true, workspaceId: true } },
          file: { select: { id: true, name: true, workspaceId: true } },
        },
      });
      return rows.flatMap((r): SearchResult[] => {
        const subject = commentSearchSubject(r, workspaceId);
        if (!subject) return [];
        return [
          {
            type: "comment",
            id: r.id,
            title: highlight(subject.title, q),
            snippet: makeSnippet(mentionsToPlain(r.body), q),
            context: `${COMMENT_SUBJECT_LABELS[subject.type]} · ${subject.title}`,
            author: r.author,
            date: r.createdAt,
            dateKind: "created",
            path: commentSubjectPath(subject),
          },
        ];
      });
    },

    todo: async () => {
      const rows = await db.todoItem.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          list: { workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
          OR: anyFieldContains<Prisma.TodoItemWhereInput>(["title", "notes"], variants),
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take,
        select: {
          id: true,
          title: true,
          notes: true,
          status: true,
          createdAt: true,
          createdBy: authorSelect,
          list: { select: { name: true } },
        },
      });
      return rows.map((r) => ({
        type: "todo",
        id: r.id,
        title: highlight(r.title, q),
        snippet: makeSnippet(r.notes, q),
        context: r.status === "DONE" ? `${r.list.name} · Tamamlandı` : r.list.name,
        author: r.createdBy,
        date: r.createdAt,
        dateKind: "created",
        path: "todos",
      }));
    },

    list: async () => {
      const rows = await db.todoList.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          ...clientVisibleWhere(ctx),
          OR: anyFieldContains<Prisma.TodoListWhereInput>(["name"], variants),
        },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          name: true,
          description: true,
          createdAt: true,
          createdBy: authorSelect,
          _count: { select: { items: { where: { deletedAt: null } } } },
        },
      });
      return rows.map((r) => ({
        type: "list",
        id: r.id,
        title: highlight(r.name, q),
        snippet: makeSnippet(r.description, q),
        context: `${r._count.items} iş`,
        author: r.createdBy,
        date: r.createdAt,
        dateKind: "created",
        path: "todos",
      }));
    },

    document: async () => {
      const rows = await db.document.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          ...documentClientWhere(ctx),
          OR: anyFieldContains<Prisma.DocumentWhereInput>(["title", "content"], variants),
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take,
        select: {
          id: true,
          title: true,
          content: true,
          updatedAt: true,
          author: authorSelect,
          folder: { select: { name: true, workspaceId: true } },
        },
      });
      return rows.map((r) => ({
        type: "document",
        id: r.id,
        title: highlight(r.title, q),
        snippet: makeSnippet(r.content, q),
        context: r.folder && r.folder.workspaceId === workspaceId ? r.folder.name : null,
        author: r.author,
        date: r.updatedAt,
        dateKind: "updated",
        path: `files/docs/${r.id}`,
      }));
    },

    file: async () => {
      const rows = await db.file.findMany({
        where: {
          workspaceId,
          fromChat: false,
          deletedAt: null,
          ...fileClientWhere(ctx),
          OR: anyFieldContains<Prisma.FileWhereInput>(["name"], variants),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: {
          id: true,
          name: true,
          mimeType: true,
          size: true,
          createdAt: true,
          uploadedBy: authorSelect,
          folder: { select: { id: true, name: true, workspaceId: true } },
        },
      });
      return rows.map((r) => {
        const folder = r.folder && r.folder.workspaceId === workspaceId ? r.folder : null;
        return {
          type: "file",
          id: r.id,
          title: highlight(r.name, q),
          snippet: null,
          context: folder ? folder.name : null,
          author: r.uploadedBy,
          date: r.createdAt,
          dateKind: "created",
          path: folder ? `files/${folder.id}` : "files",
          file: { id: r.id, mimeType: r.mimeType, size: r.size },
        };
      });
    },

    folder: async () => {
      const rows = await db.folder.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          ...clientVisibleWhere(ctx),
          OR: anyFieldContains<Prisma.FolderWhereInput>(["name"], variants),
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          name: true,
          createdAt: true,
          createdBy: authorSelect,
          parent: { select: { name: true, workspaceId: true } },
        },
      });
      return rows.map((r) => ({
        type: "folder",
        id: r.id,
        title: highlight(r.name, q),
        snippet: null,
        context: r.parent && r.parent.workspaceId === workspaceId ? r.parent.name : null,
        author: r.createdBy,
        date: r.createdAt,
        dateKind: "created",
        path: `files/${r.id}`,
      }));
    },

    event: async () => {
      const rows = await db.event.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          ...clientVisibleWhere(ctx),
          OR: anyFieldContains<Prisma.EventWhereInput>(
            ["title", "description", "location"],
            variants,
          ),
        },
        orderBy: [{ startsAt: "desc" }, { id: "desc" }],
        take,
        select: {
          id: true,
          title: true,
          description: true,
          location: true,
          startsAt: true,
          createdBy: authorSelect,
        },
      });
      return rows.map((r) => {
        const dayKey = istanbulDayKey(r.startsAt);
        const descMatches = r.description ? findMatches(r.description, q).length > 0 : false;
        const locMatches = r.location ? findMatches(r.location, q).length > 0 : false;
        // Prefer the field that matched for the snippet.
        const snippetSource = !descMatches && locMatches ? r.location : (r.description ?? r.location);
        return {
          type: "event",
          id: r.id,
          title: highlight(r.title, q),
          snippet: makeSnippet(snippetSource, q),
          context: r.location && snippetSource !== r.location ? r.location : null,
          author: r.createdBy,
          date: r.startsAt,
          dateKind: "starts",
          path: `calendar?month=${dayKey.slice(0, 7)}#agenda-${dayKey}`,
        };
      });
    },
  };

  const groups = await Promise.all(
    types.map(async (type): Promise<SearchGroup> => {
      const rows = await runners[type]();
      return {
        type,
        items: rows.slice(0, limitPerType),
        hasMore: rows.length > limitPerType,
      };
    }),
  );

  return {
    q,
    groups,
    total: groups.reduce((sum, g) => sum + g.items.length, 0),
  };
}

/** Parse the `type` search param(s) into known types; unknown values are dropped. */
export function parseSearchTypes(value: string | string[] | undefined): SearchType[] {
  const raw = (Array.isArray(value) ? value : value ? [value] : []).flatMap((v) => v.split(","));
  const known = new Set<string>(SEARCH_TYPES);
  return [...new Set(raw.map((v) => v.trim()).filter((v): v is SearchType => known.has(v)))];
}
