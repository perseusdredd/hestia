import { randomBytes } from "node:crypto";

import type { Role, User, Workspace } from "@prisma/client";

import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant-context";

/**
 * Test helpers shared by every module's tests. All rows use random emails /
 * slugs so tests can run against the shared dev DB without collisions.
 * Track what you create and call cleanup() in afterAll/afterEach.
 */

const createdUserIds = new Set<string>();
const createdWorkspaceIds = new Set<string>();
const mailedAddresses = new Set<string>();

/** Register an address that a test mailed to (not a helper user) so cleanup() removes its outbox rows. */
export function trackOutbox(email: string): string {
  mailedAddresses.add(email.toLowerCase());
  return email;
}

export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export async function createTestUser(
  overrides: Partial<Pick<User, "name" | "email" | "passwordHash">> = {},
): Promise<User> {
  const suffix = uniqueSuffix();
  const user = await db.user.create({
    data: {
      name: overrides.name ?? `Test Kullanıcı ${suffix}`,
      email: (overrides.email ?? `test-${suffix}@hestia.test`).toLowerCase(),
      passwordHash: overrides.passwordHash ?? null,
    },
  });
  createdUserIds.add(user.id);
  return user;
}

/** Creates a workspace with `ownerId` as OWNER. Returns the owner's ctx. */
export async function createTestWorkspace(
  ownerId: string,
  overrides: Partial<Pick<Workspace, "name" | "slug">> = {},
): Promise<{ workspace: Workspace; ctx: TenantContext }> {
  const suffix = uniqueSuffix();
  const workspace = await db.workspace.create({
    data: {
      name: overrides.name ?? `Test Alanı ${suffix}`,
      slug: overrides.slug ?? `test-${suffix}`,
      memberships: { create: { userId: ownerId, role: "OWNER" } },
    },
  });
  createdWorkspaceIds.add(workspace.id);
  return { workspace, ctx: { userId: ownerId, workspaceId: workspace.id, role: "OWNER" } };
}

/** Adds `userId` to the workspace with `role` and returns that member's ctx. */
export async function addMember(
  workspaceId: string,
  userId: string,
  role: Role = "MEMBER",
): Promise<TenantContext> {
  await db.membership.create({ data: { workspaceId, userId, role } });
  return { userId, workspaceId, role };
}

/** Convenience: new user + membership in one call. */
export async function createMember(workspaceId: string, role: Role = "MEMBER") {
  const user = await createTestUser();
  const ctx = await addMember(workspaceId, user.id, role);
  return { user, ctx };
}

export async function deleteTestWorkspace(workspaceId: string): Promise<void> {
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  createdWorkspaceIds.delete(workspaceId);
}

export async function deleteTestUser(userId: string): Promise<void> {
  await db.user.deleteMany({ where: { id: userId } });
  createdUserIds.delete(userId);
}

/** Deletes every workspace and user created through these helpers (cascades). */
export async function cleanup(): Promise<void> {
  // Outbox rows are not tied to users by a relation: remove the ones addressed
  // to helper users (verify / reset / invite mails) and to tracked addresses.
  if (createdUserIds.size) {
    const users = await db.user.findMany({ where: { id: { in: [...createdUserIds] } }, select: { email: true } });
    for (const u of users) mailedAddresses.add(u.email);
  }
  if (mailedAddresses.size) {
    await db.emailOutbox.deleteMany({ where: { to: { in: [...mailedAddresses] } } });
    mailedAddresses.clear();
  }
  if (createdWorkspaceIds.size) {
    await db.workspace.deleteMany({ where: { id: { in: [...createdWorkspaceIds] } } });
    createdWorkspaceIds.clear();
  }
  if (createdUserIds.size) {
    await db.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
    createdUserIds.clear();
  }
}

/** Register a workspace created outside the helpers (e.g. by createWorkspace()) for cleanup. */
export function trackWorkspace(workspaceId: string): void {
  createdWorkspaceIds.add(workspaceId);
}

export async function disconnect(): Promise<void> {
  await db.$disconnect();
}
