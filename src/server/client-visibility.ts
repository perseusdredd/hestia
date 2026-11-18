import type { Prisma } from "@prisma/client";

import { clientVisibleWhere, isGuest } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { forbidden } from "@/server/errors";

/**
 * Client / guest visibility ("Yalnızca ekip"). A GUEST sees only rows that are
 * not marked `internal`; MEMBER/ADMIN/OWNER see everything. These helpers are
 * the single place that rule lives: every read path of messages, to-dos, files,
 * documents and events spreads one of them into its where clause.
 *
 * Inheritance: a to-do item and its comments follow their list; a file follows
 * its folder; a comment follows its post / document / event / to-do list.
 * Nested folders and documents inherit the flag from their parent folder when
 * they are created or moved, and switching a folder to internal cascades down.
 */

export { clientVisibleWhere, isGuest };

/** Rejects a GUEST (FORBIDDEN). Use at the top of every mutating service function and team-only read. */
export function assertNotGuest(ctx: Pick<TenantContext, "role">, message = "Misafirler bu işlemi yapamaz."): void {
  if (isGuest(ctx.role)) throw forbidden(message);
}

/** To-do items follow their list's flag. */
export function todoItemClientWhere(ctx: Pick<TenantContext, "role">): Prisma.TodoItemWhereInput {
  return isGuest(ctx.role) ? { list: { internal: false } } : {};
}

/** Files follow their folder's flag (root files are visible); chat photos are team-only. */
export function fileClientWhere(ctx: Pick<TenantContext, "role">): Prisma.FileWhereInput {
  return isGuest(ctx.role)
    ? { AND: [{ fromChat: false }, { OR: [{ folderId: null }, { folder: { internal: false } }] }] }
    : {};
}

/** Documents carry their own flag and also follow their folder. */
export function documentClientWhere(ctx: Pick<TenantContext, "role">): Prisma.DocumentWhereInput {
  return isGuest(ctx.role)
    ? { AND: [{ internal: false }, { OR: [{ folderId: null }, { folder: { internal: false } }] }] }
    : {};
}

/** Comments follow whichever subject they belong to. */
export function commentClientWhere(ctx: Pick<TenantContext, "role">): Prisma.CommentWhereInput {
  if (!isGuest(ctx.role)) return {};
  return {
    AND: [
      { OR: [{ postId: null }, { post: { internal: false } }] },
      { OR: [{ todoItemId: null }, { todoItem: { list: { internal: false } } }] },
      { OR: [{ documentId: null }, { document: documentClientWhere(ctx) }] },
      { OR: [{ eventId: null }, { event: { internal: false } }] },
    ],
  };
}


/**
 * The `internal` flag a new row is created with: a guest can never create
 * internal rows (they could not see them), everybody else chooses.
 */
export function resolveInternal(ctx: Pick<TenantContext, "role">, requested: boolean | undefined): boolean {
  return isGuest(ctx.role) ? false : requested === true;
}

/** The flag an update writes: undefined (= leave as is) for guests or when not given. */
export function resolveInternalUpdate(
  ctx: Pick<TenantContext, "role">,
  requested: boolean | undefined,
): boolean | undefined {
  return isGuest(ctx.role) ? undefined : requested;
}
