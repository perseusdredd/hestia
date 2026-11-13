import type { Role } from "@prisma/client";

/**
 * Trusted tenant context. Only ever built by requireWorkspace() (or test
 * helpers) from the signed-in session + a DB membership lookup - never from
 * client input. Every service function takes it as its first argument.
 */
export type TenantContext = { userId: string; workspaceId: string; role: Role };
