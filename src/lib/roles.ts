import type { Role } from "@prisma/client";

export type { Role };

const RANK: Record<Role, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1 };

/** True when `role` is at least `min` (OWNER > ADMIN > MEMBER). */
export function hasRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Sahip",
  ADMIN: "Yönetici",
  MEMBER: "Üye",
};

export const ROLES: Role[] = ["OWNER", "ADMIN", "MEMBER"];

/**
 * Permission rule shared by all modules: authors can edit/delete their own
 * content; ADMIN and OWNER can edit/delete anything in the workspace.
 */
export function canModify(ctx: { userId: string; role: Role }, authorId: string): boolean {
  return ctx.userId === authorId || hasRole(ctx.role, "ADMIN");
}
