import type { Role } from "@prisma/client";

export type { Role };

const RANK: Record<Role, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1, GUEST: 0 };

/** True when `role` is at least `min` (OWNER > ADMIN > MEMBER > GUEST). */
export function hasRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Sahip",
  ADMIN: "Yönetici",
  MEMBER: "Üye",
  GUEST: "Misafir / Müşteri",
};

export const ROLES: Role[] = ["OWNER", "ADMIN", "MEMBER", "GUEST"];

/**
 * Permission rule shared by all modules: authors can edit/delete their own
 * content; ADMIN and OWNER can edit/delete anything in the workspace.
 */
export function canModify(ctx: { userId: string; role: Role }, authorId: string): boolean {
  return ctx.userId === authorId || hasRole(ctx.role, "ADMIN");
}

/** A client / guest: sees only items that are not marked internal ("Yalnızca ekip"). */
export function isGuest(role: Role): boolean {
  return role === "GUEST";
}

/**
 * Prisma where fragment for entities with an `internal` flag (Post, TodoList,
 * Folder, Document, Event): a GUEST only gets non-internal rows, everybody else
 * everything. Spread it into every read path of those entities.
 */
export function clientVisibleWhere(ctx: { role: Role }): { internal?: false } {
  return isGuest(ctx.role) ? { internal: false } : {};
}
