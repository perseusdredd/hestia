import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { dateOnlyToDb, dbToDateOnly, isDateOnly } from "@/lib/date-only";
import { db } from "@/lib/db";
import { toIstanbulInputValue } from "@/lib/istanbul-time";
import { canModify, clientVisibleWhere, isGuest } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { forgetActivity, recordActivity, recordTodoToggled, syncActivityInternal } from "@/server/activity";
import { assertNotGuest, resolveInternal, resolveInternalUpdate, todoItemClientWhere } from "@/server/client-visibility";
import { conflict, forbidden, notFound, ServiceError, parseInput } from "@/server/errors";
import { notifyTodoAssigned } from "@/server/notifications";
import { reminderColumns, remindAtField } from "@/server/reminders";
import { assertAssignableProject, projectIdField } from "@/server/projects";
import { autoSubscribe } from "@/server/subscriptions";
import { isWorkspaceMember } from "@/server/workspaces";
import { deleteReactionsFor } from "@/server/reactions";

/**
 * To-do lists and items. Every function is scoped by ctx.workspaceId.
 * Permissions: any member can create lists/items and toggle completion;
 * edit/delete needs the author or an ADMIN/OWNER.
 */

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

const listNameSchema = z
  .string()
  .trim()
  .min(1, "Liste adı gerekli.")
  .max(120, "Liste adı en fazla 120 karakter olabilir.");
const listDescriptionSchema = z.preprocess(
  emptyToNull,
  z.string().trim().max(2000, "Açıklama en fazla 2000 karakter olabilir.").nullable(),
);
const titleSchema = z
  .string()
  .trim()
  .min(1, "Başlık gerekli.")
  .max(300, "Başlık en fazla 300 karakter olabilir.");
const notesSchema = z.preprocess(
  emptyToNull,
  z.string().trim().max(5000, "Notlar en fazla 5000 karakter olabilir.").nullable(),
);
const assigneeSchema = z.preprocess(emptyToNull, z.string().min(1).max(64).nullable());
const dueDateSchema = z.preprocess(
  emptyToNull,
  z.string().refine(isDateOnly, "Geçerli bir tarih girin.").nullable(),
);

const startDateSchema = dueDateSchema;
const sectionIdSchema = z.preprocess(emptyToNull, z.string().min(1).max(64).nullable());
const extraAssigneesSchema = z.array(z.string().min(1).max(64)).max(50, "En fazla 50 kişi atanabilir.");
const sectionNameSchema = z
  .string()
  .trim()
  .min(1, "Bölüm adı gerekli.")
  .max(120, "Bölüm adı en fazla 120 karakter olabilir.");

const createListSchema = z.object({
  name: listNameSchema,
  description: listDescriptionSchema.optional(),
  /** Optional project; empty / omitted = "Genel". */
  projectId: projectIdField,
  /** "Yalnızca ekip": hidden from guests (ignored when a guest creates the list). */
  internal: z.boolean().optional(),
});
const updateListSchema = z.object({
  name: listNameSchema.optional(),
  description: listDescriptionSchema.optional(),
  internal: z.boolean().optional(),
});
// yyyy-MM-dd strings compare correctly as plain strings, so a start date must
// not fall after the due date.
const startNotAfterDue = (v: { startOn?: string | null; dueDate?: string | null }) =>
  !v.startOn || !v.dueDate || v.startOn <= v.dueDate;
const startNotAfterDueError = {
  message: "Başlangıç tarihi bitiş tarihinden sonra olamaz.",
  path: ["startOn"] as PropertyKey[],
};

const createItemSchema = z
  .object({
    title: titleSchema,
    notes: notesSchema.optional(),
    assigneeId: assigneeSchema.optional(),
    dueDate: dueDateSchema.optional(),
    startOn: startDateSchema.optional(),
    sectionId: sectionIdSchema.optional(),
    extraAssigneeIds: extraAssigneesSchema.optional(),
    remindAt: remindAtField,
  })
  .refine(startNotAfterDue, startNotAfterDueError);
const updateItemSchema = z
  .object({
    title: titleSchema.optional(),
    notes: notesSchema.optional(),
    assigneeId: assigneeSchema.optional(),
    dueDate: dueDateSchema.optional(),
    startOn: startDateSchema.optional(),
    sectionId: sectionIdSchema.optional(),
    extraAssigneeIds: extraAssigneesSchema.optional(),
    remindAt: remindAtField,
  })
  .refine(startNotAfterDue, startNotAfterDueError);

export type TodoUser = { id: string; name: string | null; email: string; image: string | null };

export type TodoItemDTO = {
  id: string;
  listId: string;
  title: string;
  notes: string | null;
  done: boolean;
  dueDate: string | null; // yyyy-MM-dd, no timezone
  completedAt: string | null;
  assigneeId: string | null;
  assignee: TodoUser | null;
  /** Additional assignees besides the primary one. */
  extraAssignees: TodoUser[];
  startOn: string | null; // yyyy-MM-dd, no timezone
  /** Reminder as Istanbul wall time "YYYY-MM-DDTHH:mm" ("" = none). */
  remindAt: string;
  sectionId: string | null;
  canEdit: boolean;
};

export type TodoSectionDTO = { id: string; name: string; position: number };

export type TodoListDTO = {
  id: string;
  name: string;
  description: string | null;
  createdById: string;
  canEdit: boolean;
  internal: boolean;
  hillPosition: number;
  hillNote: string | null;
  total: number;
  doneCount: number;
  /** Completed items not loaded (beyond DONE_ITEMS_PER_LIST); not counted as filtered out. */
  hiddenDone: number;
  sections: TodoSectionDTO[];
  items: TodoItemDTO[];
};

const userSelect = { id: true, name: true, email: true, image: true } as const;

type ItemRow = {
  id: string;
  listId: string;
  title: string;
  notes: string | null;
  status: "OPEN" | "DONE";
  dueDate: Date | null;
  completedAt: Date | null;
  assigneeId: string | null;
  createdById: string;
  assignee: TodoUser | null;
  startOn?: Date | null;
  remindAt?: Date | null;
  sectionId?: string | null;
  extraAssignees?: { user: TodoUser }[];
};

function toItemDTO(ctx: TenantContext, i: ItemRow): TodoItemDTO {
  return {
    id: i.id,
    listId: i.listId,
    title: i.title,
    notes: i.notes,
    done: i.status === "DONE",
    dueDate: i.dueDate ? dbToDateOnly(i.dueDate) : null,
    completedAt: i.completedAt ? i.completedAt.toISOString() : null,
    assigneeId: i.assigneeId,
    assignee: i.assignee,
    extraAssignees: (i.extraAssignees ?? []).map((e) => e.user),
    startOn: i.startOn ? dbToDateOnly(i.startOn) : null,
    remindAt: i.remindAt ? toIstanbulInputValue(i.remindAt, true) : "",
    sectionId: i.sectionId ?? null,
    canEdit: canModify(ctx, i.createdById),
  };
}

const extraAssigneesInclude = {
  extraAssignees: { orderBy: { createdAt: "asc" as const }, select: { user: { select: userSelect } } },
} as const;

/** Every extra assignee must be a member of this workspace. */
async function requireExtraAssignees(ctx: TenantContext, ids: string[]) {
  for (const id of ids) {
    if (!(await isWorkspaceMember(ctx, id))) {
      throw new ServiceError("VALIDATION", "Atanan kişi bu çalışma alanının üyesi olmalı.", {
        extraAssigneeIds: ["Atanan kişi bu çalışma alanının üyesi olmalı."],
      });
    }
  }
}

/** Unique extra assignee ids, without the primary assignee. */
function cleanExtras(ids: string[], primary: string | null | undefined): string[] {
  return [...new Set(ids)].filter((id) => id !== primary);
}

async function requireSection(ctx: TenantContext, listId: string, sectionId: string | null | undefined) {
  if (!sectionId) return;
  const section = await db.todoSection.findFirst({ where: { id: sectionId, listId, workspaceId: ctx.workspaceId } });
  if (!section) {
    throw new ServiceError("VALIDATION", "Bölüm bu listeye ait olmalı.", {
      sectionId: ["Bölüm bu listeye ait olmalı."],
    });
  }
}

async function requireAssignee(ctx: TenantContext, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  if (!(await isWorkspaceMember(ctx, assigneeId))) {
    throw new ServiceError("VALIDATION", "Atanan kişi bu çalışma alanının üyesi olmalı.", {
      assigneeId: ["Atanan kişi bu çalışma alanının üyesi olmalı."],
    });
  }
}

/**
 * Completed items loaded per list. Open items are always all there; a list
 * with thousands of finished items sends only the first DONE_ITEMS_PER_LIST
 * (in list order) and reports the rest in `doneCount` / `hiddenDone`.
 */
export const DONE_ITEMS_PER_LIST = 50;

/**
 * Lists with their items. `assignedToMe` keeps only my items (progress still
 * counts the whole list). Four queries whatever the size: lists, open items,
 * the first DONE_ITEMS_PER_LIST done ids per list (window function), those
 * done items, plus one grouped count for the progress numbers.
 */
export async function listTodoLists(
  ctx: TenantContext,
  opts: { assignedToMe?: boolean } = {},
): Promise<TodoListDTO[]> {
  const order = [{ position: "asc" as const }, { createdAt: "asc" as const }, { id: "asc" as const }];
  const include = { assignee: { select: userSelect }, ...extraAssigneesInclude } as const;
  const [lists, openItems, doneIds, counts, sections] = await Promise.all([
    db.todoList.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
      orderBy: order,
    }),
    db.todoItem.findMany({
      where: { workspaceId: ctx.workspaceId, status: "OPEN", deletedAt: null, ...todoItemClientWhere(ctx) },
      orderBy: order,
      include,
    }),
    db.$queryRaw<{ id: string }[]>`
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY "listId" ORDER BY position, "createdAt", id) AS rn
        FROM "TodoItem"
        WHERE "workspaceId" = ${ctx.workspaceId} AND status = 'DONE' AND "deletedAt" IS NULL
          AND (${!isGuest(ctx.role)}::boolean OR "listId" IN (
            SELECT id FROM "TodoList" WHERE "workspaceId" = ${ctx.workspaceId} AND internal = false))
      ) ranked
      WHERE rn <= ${DONE_ITEMS_PER_LIST}`,
    db.todoItem.groupBy({
      by: ["listId", "status"],
      where: { workspaceId: ctx.workspaceId, deletedAt: null, ...todoItemClientWhere(ctx) },
      _count: { _all: true },
    }),
    db.todoSection.findMany({
      where: { workspaceId: ctx.workspaceId, list: { deletedAt: null, ...clientVisibleWhere(ctx) } },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const sectionsByList = new Map<string, TodoSectionDTO[]>();
  for (const sec of sections) {
    const bucket = sectionsByList.get(sec.listId) ?? [];
    bucket.push({ id: sec.id, name: sec.name, position: sec.position });
    sectionsByList.set(sec.listId, bucket);
  }
  const doneItems = doneIds.length
    ? await db.todoItem.findMany({
        where: { workspaceId: ctx.workspaceId, id: { in: doneIds.map((r) => r.id) }, ...todoItemClientWhere(ctx) },
        orderBy: order,
        include,
      })
    : [];

  const itemsByList = new Map<string, TodoItemDTO[]>();
  for (const row of [...openItems, ...doneItems]) {
    const bucket = itemsByList.get(row.listId) ?? [];
    bucket.push(toItemDTO(ctx, row));
    itemsByList.set(row.listId, bucket);
  }
  const countsByList = new Map<string, { total: number; done: number }>();
  for (const c of counts) {
    const entry = countsByList.get(c.listId) ?? { total: 0, done: 0 };
    entry.total += c._count._all;
    if (c.status === "DONE") entry.done += c._count._all;
    countsByList.set(c.listId, entry);
  }

  const result = lists.map((l) => {
    const loaded = itemsByList.get(l.id) ?? [];
    const { total, done } = countsByList.get(l.id) ?? { total: 0, done: 0 };
    const loadedDone = loaded.filter((i) => i.done).length;
    const items = opts.assignedToMe
      ? loaded.filter((i) => i.assigneeId === ctx.userId || i.extraAssignees.some((u) => u.id === ctx.userId))
      : loaded;
    return {
      id: l.id,
      name: l.name,
      description: l.description,
      createdById: l.createdById,
      canEdit: canModify(ctx, l.createdById),
      internal: l.internal,
      hillPosition: l.hillPosition,
      hillNote: l.hillNote,
      total,
      doneCount: done,
      // With the filter on, everything not shown counts as filtered out.
      hiddenDone: opts.assignedToMe ? 0 : done - loadedDone,
      sections: sectionsByList.get(l.id) ?? [],
      items,
    };
  });
  return opts.assignedToMe ? result.filter((l) => l.items.length > 0) : result;
}

export type MyOpenTodo = TodoItemDTO & { listName: string; overdue: boolean };

/**
 * Open items assigned to the current user, overdue first, then by due date
 * (undated last), then oldest first. `today` is a "yyyy-MM-dd" date-only string.
 */
export async function listMyOpenTodos(
  ctx: TenantContext,
  opts: { today: string; take?: number },
): Promise<{ items: MyOpenTodo[]; total: number }> {
  if (!isDateOnly(opts.today)) throw new ServiceError("VALIDATION", "Geçersiz tarih.");
  const take = Math.min(Math.max(opts.take ?? 8, 1), 50);
  const where = {
    workspaceId: ctx.workspaceId,
    OR: [{ assigneeId: ctx.userId }, { extraAssignees: { some: { userId: ctx.userId } } }],
    status: "OPEN" as const,
    deletedAt: null,
    ...todoItemClientWhere(ctx),
  };
  const [rows, total] = await Promise.all([
    db.todoItem.findMany({
      where,
      // Postgres sorts NULLs last for ASC, so undated items come after dated ones.
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      take,
      include: { assignee: { select: userSelect }, list: { select: { name: true } }, ...extraAssigneesInclude },
    }),
    db.todoItem.count({ where }),
  ]);
  const items = rows.map((r) => {
    const dto = toItemDTO(ctx, r);
    return { ...dto, listName: r.list.name, overdue: dto.dueDate !== null && dto.dueDate < opts.today };
  });
  return { items, total };
}

/**
 * Serialise list-position changes (create, reorder) per workspace. An advisory
 * lock works even when the workspace has no lists yet, where row locks on
 * "TodoList" would lock nothing. Released at COMMIT/ROLLBACK.
 */
async function lockListPositions(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`todolist-positions:${workspaceId}`}))`;
}

export async function createTodoList(ctx: TenantContext, input: unknown) {
  const data = parseInput(createListSchema, input);
  const projectId = await assertAssignableProject(ctx, data.projectId);
  const list = await db.$transaction(async (tx) => {
    await lockListPositions(tx, ctx.workspaceId);
    const max = await tx.todoList.aggregate({
      where: { workspaceId: ctx.workspaceId },
      _max: { position: true },
    });
    return tx.todoList.create({
      data: {
        workspaceId: ctx.workspaceId,
        createdById: ctx.userId,
        name: data.name,
        description: data.description ?? null,
        projectId,
        internal: resolveInternal(ctx, data.internal),
        position: (max._max.position ?? -1) + 1,
      },
    });
  });
  await recordActivity(ctx, {
    type: "TODO_LIST_CREATED",
    title: list.name,
    path: "todos",
    subject: { type: "todoList", id: list.id },
  }); // after commit
  return list;
}

async function getList(ctx: TenantContext, id: string) {
  const list = await db.todoList.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
  });
  if (!list) throw notFound("Liste bulunamadı.");
  return list;
}

export async function updateTodoList(ctx: TenantContext, id: string, input: unknown) {
  const data = parseInput(updateListSchema, input);
  const list = await getList(ctx, id);
  if (!canModify(ctx, list.createdById)) throw forbidden();
  const internal = resolveInternalUpdate(ctx, data.internal);
  const res = await db.todoList.updateMany({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(internal !== undefined ? { internal } : {}),
    },
  });
  if (res.count === 0) throw notFound("Liste bulunamadı.");
  if (internal !== undefined && internal !== list.internal) {
    await syncActivityInternal(ctx, { type: "todoList", id: list.id });
  }
}

/**
 * Moves the list and its items to the trash (soft delete). Items share the
 * list's deletedAt, so restoring the list brings back exactly those items.
 */
export async function deleteTodoList(ctx: TenantContext, id: string) {
  const list = await getList(ctx, id);
  if (!canModify(ctx, list.createdById)) throw forbidden();
  await db.$transaction(async (tx) => {
    // Before the delete: the list's items and their comments are found through their foreign keys.
    await forgetActivity(ctx, [{ type: "todoList", id: list.id }], tx);
    const stamp = { deletedAt: new Date(), deletedById: ctx.userId };
    await tx.todoItem.updateMany({
      where: { listId: list.id, workspaceId: ctx.workspaceId, deletedAt: null },
      data: stamp,
    });
    await tx.todoList.updateMany({
      where: { id: list.id, workspaceId: ctx.workspaceId, deletedAt: null },
      data: { ...stamp, updatedAt: list.updatedAt },
    });
  });
}

export async function createTodoItem(ctx: TenantContext, listId: string, input: unknown) {
  const data = parseInput(createItemSchema, input);
  const parentList = await getList(ctx, listId); // parent must belong to this workspace
  await requireAssignee(ctx, data.assigneeId);
  const extras = cleanExtras(data.extraAssigneeIds ?? [], data.assigneeId);
  await requireExtraAssignees(ctx, extras);
  await requireSection(ctx, listId, data.sectionId);
  const item = await db.$transaction(async (tx) => {
    // Serialise position allocation per list.
    await tx.$queryRaw`SELECT id FROM "TodoList" WHERE id = ${listId} AND "workspaceId" = ${ctx.workspaceId} FOR UPDATE`;
    const max = await tx.todoItem.aggregate({
      where: { listId, workspaceId: ctx.workspaceId },
      _max: { position: true },
    });
    return tx.todoItem.create({
      data: {
        workspaceId: ctx.workspaceId,
        listId,
        createdById: ctx.userId,
        title: data.title,
        notes: data.notes ?? null,
        assigneeId: data.assigneeId ?? null,
        dueDate: data.dueDate ? dateOnlyToDb(data.dueDate) : null,
        startOn: data.startOn ? dateOnlyToDb(data.startOn) : null,
        sectionId: data.sectionId ?? null,
        remindAt: data.remindAt ?? null,
        position: (max._max.position ?? -1) + 1,
        ...(extras.length
          ? { extraAssignees: { create: extras.map((userId) => ({ workspaceId: ctx.workspaceId, userId })) } }
          : {}),
      },
    });
  });
  // After the main write; never fails the action.
  await autoSubscribe(ctx, { type: "todo", id: item.id }, [
    ctx.userId,
    ...(item.assigneeId ? [item.assigneeId] : []),
    ...extras,
  ]);
  for (const userId of extras) {
    await notifyTodoAssigned(ctx, {
      id: item.id,
      title: item.title,
      assigneeId: userId,
      internal: parentList.internal,
    });
  }
  if (item.assigneeId) {
    await notifyTodoAssigned(ctx, {
      id: item.id,
      title: item.title,
      assigneeId: item.assigneeId,
      internal: parentList.internal,
    });
  }
  await recordActivity(ctx, {
    type: "TODO_CREATED",
    title: item.title,
    path: "todos",
    subject: { type: "todoItem", id: item.id },
  });
  return item;
}

const personSelect = { select: { id: true, name: true, email: true, image: true } } as const;
const itemIdSchema = z.string().min(1).max(64);

/** One to-do with what its detail page shows. NOT_FOUND for ids from other workspaces. */
export async function getTodoItemDetail(ctx: TenantContext, itemId: string) {
  const id = parseInput(itemIdSchema, itemId);
  const item = await db.todoItem.findFirst({
    where: {
      id,
      workspaceId: ctx.workspaceId,
      deletedAt: null,
      list: { workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
    },
    select: {
      id: true,
      title: true,
      notes: true,
      status: true,
      dueDate: true,
      startOn: true,
      remindAt: true,
      sectionId: true,
      section: { select: { name: true } },
      completedAt: true,
      createdAt: true,
      createdById: true,
      list: { select: { id: true, name: true, internal: true } },
      createdBy: personSelect,
      assignee: personSelect,
      extraAssignees: { orderBy: { createdAt: "asc" }, select: { user: personSelect } },
    },
  });
  if (!item) throw notFound("Görev bulunamadı.");
  return {
    ...item,
    done: item.status === "DONE",
    dueDate: item.dueDate ? dbToDateOnly(item.dueDate) : null,
    startOn: item.startOn ? dbToDateOnly(item.startOn) : null,
    remindAt: item.remindAt ? item.remindAt.toISOString() : null,
    sectionName: item.section?.name ?? null,
    extraAssignees: item.extraAssignees.map((e) => e.user),
    canEdit: canModify(ctx, item.createdById),
  };
}

async function getItem(ctx: TenantContext, id: string) {
  const item = await db.todoItem.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null, list: { deletedAt: null, ...clientVisibleWhere(ctx) } },
    include: { list: { select: { internal: true } } },
  });
  if (!item) throw notFound("Görev bulunamadı.");
  return item;
}

export async function updateTodoItem(ctx: TenantContext, id: string, input: unknown) {
  const data = parseInput(updateItemSchema, input);
  const item = await getItem(ctx, id);
  if (!canModify(ctx, item.createdById)) throw forbidden();
  await requireAssignee(ctx, data.assigneeId);
  const primary = data.assigneeId !== undefined ? data.assigneeId : item.assigneeId;
  const extras = data.extraAssigneeIds ? cleanExtras(data.extraAssigneeIds, primary) : undefined;
  if (extras) await requireExtraAssignees(ctx, extras);
  await requireSection(ctx, item.listId, data.sectionId);
  const previousExtras = extras
    ? (await db.todoAssignee.findMany({ where: { todoItemId: item.id, workspaceId: ctx.workspaceId } })).map(
        (r) => r.userId,
      )
    : [];
  const fields = {
      ...reminderColumns(data.remindAt, item.remindAt),
      ...(data.startOn !== undefined ? { startOn: data.startOn ? dateOnlyToDb(data.startOn) : null } : {}),
      ...(data.sectionId !== undefined ? { sectionId: data.sectionId } : {}),
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      ...(data.assigneeId !== undefined ? { assigneeId: data.assigneeId } : {}),
      ...(data.dueDate !== undefined
        ? { dueDate: data.dueDate ? dateOnlyToDb(data.dueDate) : null }
        : {}),
  };
  // Only extra assignees changed: nothing to write on the row itself (item existence was checked above).
  if (Object.keys(fields).length > 0) {
    const res = await db.todoItem.updateMany({
      where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
      data: fields,
    });
    if (res.count === 0) throw notFound("Görev bulunamadı.");
  }
  if (extras) {
    await db.$transaction([
      db.todoAssignee.deleteMany({
        where: { todoItemId: item.id, workspaceId: ctx.workspaceId, userId: { notIn: extras } },
      }),
      db.todoAssignee.createMany({
        data: extras.map((userId) => ({ workspaceId: ctx.workspaceId, todoItemId: item.id, userId })),
        skipDuplicates: true,
      }),
    ]);
    for (const userId of extras.filter((u) => !previousExtras.includes(u))) {
      await autoSubscribe(ctx, { type: "todo", id: item.id }, [userId]);
      await notifyTodoAssigned(ctx, {
        id: item.id,
        title: data.title ?? item.title,
        assigneeId: userId,
        internal: item.list.internal,
      });
    }
  } else if (data.assigneeId) {
    // A new primary assignee must not also stay an extra one.
    await db.todoAssignee.deleteMany({
      where: { todoItemId: item.id, workspaceId: ctx.workspaceId, userId: data.assigneeId },
    });
  }
  // Assigned or reassigned to someone new: tell the assignee (after the write).
  if (data.assigneeId && data.assigneeId !== item.assigneeId) {
    await autoSubscribe(ctx, { type: "todo", id: item.id }, [data.assigneeId]);
    await notifyTodoAssigned(ctx, {
      id: item.id,
      title: data.title ?? item.title,
      assigneeId: data.assigneeId,
      internal: item.list.internal,
    });
  }
}

/** Any member may mark an item done / open. */
export async function setTodoItemDone(ctx: TenantContext, id: string, done: boolean) {
  const res = await db.todoItem.updateMany({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null, list: { deletedAt: null, ...clientVisibleWhere(ctx) } },
    data: done ? { status: "DONE", completedAt: new Date() } : { status: "OPEN", completedAt: null },
  });
  if (res.count === 0) throw notFound("Görev bulunamadı.");
  await recordTodoToggled(ctx, id, done);
}

/** Moves the item to the trash (soft delete). */
export async function deleteTodoItem(ctx: TenantContext, id: string) {
  const item = await getItem(ctx, id);
  if (!canModify(ctx, item.createdById)) throw forbidden();
  await db.$transaction(async (tx) => {
    await forgetActivity(ctx, [{ type: "todoItem", id: item.id }], tx);
    await deleteReactionsFor(tx, ctx.workspaceId, "todoItem", [item.id]);
    await tx.todoItem.updateMany({
      where: { id: item.id, workspaceId: ctx.workspaceId, deletedAt: null },
      data: { deletedAt: new Date(), deletedById: ctx.userId, updatedAt: item.updatedAt },
    });
  });
}

// ---------------------------------------------------------------------------
// Reordering. Positions are always rewritten densely (0..n-1) inside a
// transaction that holds row locks on the affected lists, so concurrent moves
// serialise and can never leave duplicates or gaps.
// ---------------------------------------------------------------------------

export type MoveDirection = "up" | "down";

const directionSchema = z.enum(["up", "down"], { error: "Geçersiz yön." });
const moveItemSchema = z
  .object({
    direction: directionSchema.optional(),
    listId: z.string().min(1).max(64).optional(),
  })
  .refine((v) => (v.direction === undefined) !== (v.listId === undefined), {
    message: "Yön veya hedef liste belirtin.",
  });

type Tx = Prisma.TransactionClient;

/** Locks the given lists of this workspace in a stable (id) order; returns how many were found. */
async function lockLists(tx: Tx, ctx: TenantContext, listIds: string[]): Promise<number> {
  const ids = [...new Set(listIds)].sort();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "TodoList"
    WHERE "workspaceId" = ${ctx.workspaceId} AND id = ANY(${ids}::text[])
    ORDER BY id FOR UPDATE`;
  return rows.length;
}

/** Moves `index` one step toward `dir`, hopping over entries that fail `sameGroup`. */
function moved<T>(arr: T[], index: number, dir: MoveDirection, sameGroup: (o: T) => boolean): T[] {
  const step = dir === "up" ? -1 : 1;
  let j = index + step;
  while (j >= 0 && j < arr.length && !sameGroup(arr[j])) j += step;
  if (j < 0 || j >= arr.length) return arr;
  const next = [...arr];
  const [x] = next.splice(index, 1);
  next.splice(j, 0, x);
  return next;
}

async function writeItemPositions(
  tx: Tx,
  ctx: TenantContext,
  listId: string,
  ordered: { id: string; position: number; listId: string }[],
) {
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i];
    if (row.position === i && row.listId === listId) continue;
    await tx.todoItem.updateMany({
      where: { id: row.id, workspaceId: ctx.workspaceId },
      data: { position: i, listId },
    });
  }
}

const itemOrder = [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }] as const;

/**
 * Moves an item one step up/down inside its list (hopping over items with the
 * other completion state, which the UI shows in a separate group), or moves it
 * to the end of another list of the same workspace. Same permission as editing.
 */
export async function moveTodoItem(ctx: TenantContext, id: string, input: unknown) {
  const data = parseInput(moveItemSchema, input);
  const item = await getItem(ctx, id);
  if (!canModify(ctx, item.createdById)) throw forbidden();
  const targetListId = data.listId && data.listId !== item.listId ? data.listId : null;
  if (data.listId !== undefined && !targetListId) return; // already in that list
  if (targetListId) await getList(ctx, targetListId); // target must belong to this workspace

  await db.$transaction(async (tx) => {
    const lockIds = targetListId ? [item.listId, targetListId] : [item.listId];
    const locked = await lockLists(tx, ctx, lockIds);
    if (locked !== new Set(lockIds).size) throw notFound("Liste bulunamadı.");
    // The item may have been moved or deleted while we waited for the lock.
    const fresh = await tx.todoItem.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null } });
    if (!fresh) throw notFound("Görev bulunamadı.");
    if (fresh.listId !== item.listId) {
      throw conflict("Görev başka bir yerde taşındı. Sayfayı yenileyip tekrar deneyin.");
    }

    const source = await tx.todoItem.findMany({
      where: { listId: item.listId, workspaceId: ctx.workspaceId, deletedAt: null },
      orderBy: [...itemOrder],
      select: { id: true, position: true, listId: true, status: true, sectionId: true },
    });

    if (data.direction) {
      const index = source.findIndex((r) => r.id === id);
      const ordered = moved(
        source,
        index,
        data.direction,
        (o) => o.status === fresh.status && o.sectionId === fresh.sectionId,
      );
      await writeItemPositions(tx, ctx, item.listId, ordered);
      return;
    }

    const target = await tx.todoItem.findMany({
      where: { listId: targetListId!, workspaceId: ctx.workspaceId, deletedAt: null },
      orderBy: [...itemOrder],
      select: { id: true, position: true, listId: true },
    });
    await writeItemPositions(
      tx,
      ctx,
      item.listId,
      source.filter((r) => r.id !== id),
    );
    await writeItemPositions(tx, ctx, targetListId!, [
      ...target,
      { id, position: -1, listId: item.listId },
    ]);
    // Sections belong to one list: the moved item leaves its section.
    await tx.todoItem.updateMany({ where: { id, workspaceId: ctx.workspaceId }, data: { sectionId: null } });
  });
  // The item now inherits another list's team-only flag: re-derive its feed rows and its comments'.
  if (targetListId) await syncActivityInternal(ctx, { type: "todoItem", id });
}

/** Moves a list one step up/down among the workspace's lists. Same permission as editing the list. */
export async function moveTodoList(ctx: TenantContext, id: string, direction: unknown) {
  assertNotGuest(ctx); // reordering touches every list's position, including team-only ones
  const dir = parseInput(directionSchema, direction);
  const list = await getList(ctx, id);
  if (!canModify(ctx, list.createdById)) throw forbidden();
  await db.$transaction(async (tx) => {
    // Serialise every list reorder (and list create) in this workspace.
    await lockListPositions(tx, ctx.workspaceId);
    await tx.$queryRaw`SELECT id FROM "TodoList" WHERE "workspaceId" = ${ctx.workspaceId} ORDER BY id FOR UPDATE`;
    const rows = await tx.todoList.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, position: true },
    });
    const index = rows.findIndex((r) => r.id === id);
    if (index === -1) throw notFound("Liste bulunamadı.");
    const ordered = moved(rows, index, dir, () => true);
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].position === i) continue;
      await tx.todoList.updateMany({
        where: { id: ordered[i].id, workspaceId: ctx.workspaceId },
        data: { position: i },
      });
    }
  });
}

/** id + name of every list in the workspace (move targets), in display order. */
export async function listTodoListOptions(ctx: TenantContext): Promise<{ id: string; name: string }[]> {
  return db.todoList.findMany({
    where: { workspaceId: ctx.workspaceId, deletedAt: null, ...clientVisibleWhere(ctx) },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true },
  });
}

// ---------------------------------------------------------------------------
// Sections: optional named headers inside a list. Positions are dense (0..n-1)
// per list. Deleting a section keeps its items (sectionId becomes null).
// ---------------------------------------------------------------------------

const sectionRefSchema = z.string().min(1).max(64);

async function lockSections(tx: Tx, ctx: TenantContext, listId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`todosection-positions:${ctx.workspaceId}:${listId}`}))`;
}

async function getSection(ctx: TenantContext, id: string) {
  const parsed = parseInput(sectionRefSchema, id);
  const section = await db.todoSection.findFirst({
    where: { id: parsed, workspaceId: ctx.workspaceId, list: { deletedAt: null, ...clientVisibleWhere(ctx) } },
    include: { list: { select: { createdById: true } } },
  });
  if (!section) throw notFound("Bölüm bulunamadı.");
  if (!canModify(ctx, section.list.createdById)) throw forbidden();
  return section;
}

export async function createTodoSection(ctx: TenantContext, listId: string, input: unknown) {
  const data = parseInput(z.object({ name: sectionNameSchema }), input);
  const list = await getList(ctx, listId);
  if (!canModify(ctx, list.createdById)) throw forbidden();
  return db.$transaction(async (tx) => {
    await lockSections(tx, ctx, list.id);
    const max = await tx.todoSection.aggregate({
      where: { listId: list.id, workspaceId: ctx.workspaceId },
      _max: { position: true },
    });
    return tx.todoSection.create({
      data: {
        workspaceId: ctx.workspaceId,
        listId: list.id,
        name: data.name,
        position: (max._max.position ?? -1) + 1,
      },
    });
  });
}

export async function renameTodoSection(ctx: TenantContext, id: string, input: unknown) {
  const data = parseInput(z.object({ name: sectionNameSchema }), input);
  const section = await getSection(ctx, id);
  await db.todoSection.updateMany({
    where: { id: section.id, workspaceId: ctx.workspaceId },
    data: { name: data.name },
  });
}

/** Moves a section one step up/down among its list's sections (dense positions). */
export async function moveTodoSection(ctx: TenantContext, id: string, direction: unknown) {
  const dir = parseInput(directionSchema, direction);
  const section = await getSection(ctx, id);
  await db.$transaction(async (tx) => {
    await lockSections(tx, ctx, section.listId);
    const rows = await tx.todoSection.findMany({
      where: { listId: section.listId, workspaceId: ctx.workspaceId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, position: true },
    });
    const index = rows.findIndex((r) => r.id === section.id);
    if (index === -1) throw notFound("Bölüm bulunamadı.");
    const ordered = moved(rows, index, dir, () => true);
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].position === i) continue;
      await tx.todoSection.updateMany({
        where: { id: ordered[i].id, workspaceId: ctx.workspaceId },
        data: { position: i },
      });
    }
  });
}

/** Deletes the section; its items stay in the list, ungrouped. */
export async function deleteTodoSection(ctx: TenantContext, id: string) {
  const section = await getSection(ctx, id);
  await db.$transaction(async (tx) => {
    await lockSections(tx, ctx, section.listId);
    await tx.todoItem.updateMany({
      where: { sectionId: section.id, workspaceId: ctx.workspaceId },
      data: { sectionId: null },
    });
    await tx.todoSection.deleteMany({ where: { id: section.id, workspaceId: ctx.workspaceId } });
    const rest = await tx.todoSection.findMany({
      where: { listId: section.listId, workspaceId: ctx.workspaceId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, position: true },
    });
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].position === i) continue;
      await tx.todoSection.updateMany({ where: { id: rest[i].id }, data: { position: i } });
    }
  });
}
