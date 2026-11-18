import type { Prisma } from "@prisma/client";

import { clientVisibleWhere } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";

/**
 * Drafts (publishedAt = null) are visible only to their author. Every query
 * that reads posts on behalf of a member must include this filter. A GUEST
 * additionally never sees internal ("Yalnızca ekip") posts.
 */
export function visiblePostWhere(ctx: Pick<TenantContext, "userId" | "role">): Prisma.PostWhereInput {
  return { OR: [{ publishedAt: { not: null } }, { authorId: ctx.userId }], ...clientVisibleWhere(ctx) };
}
