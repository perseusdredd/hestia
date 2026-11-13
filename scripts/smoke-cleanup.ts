/**
 * Deletes the data the HTTP smoke test and the browser e2e suite create:
 * workspaces whose slug starts with the prefix (activity rows cascade), users
 * with a <prefix>*@hestia.test email (their auth tokens), EmailOutbox rows
 * addressed to such an email, and the stored file objects.
 *
 *   npx tsx scripts/smoke-cleanup.ts          # prefix "smoke-" (scripts/smoke.mjs)
 *   npx tsx scripts/smoke-cleanup.ts e2e-     # prefix "e2e-"   (Playwright suite)
 */
import { PrismaClient } from "@prisma/client";

import { getStorage } from "../src/lib/storage";

try {
  process.loadEnvFile(".env");
} catch {
  // env may come from the shell
}

const ALLOWED_PREFIXES = ["smoke-", "e2e-"];
const prefix = process.argv[2] ?? "smoke-";
if (!ALLOWED_PREFIXES.includes(prefix)) {
  console.error(`Unknown prefix "${prefix}". Use one of: ${ALLOWED_PREFIXES.join(", ")}`);
  process.exit(1);
}

const db = new PrismaClient();

async function main() {
  const workspaces = await db.workspace.findMany({
    where: { slug: { startsWith: prefix } },
    select: { id: true },
  });
  const ids = workspaces.map((w) => w.id);
  const files = await db.file.findMany({ where: { workspaceId: { in: ids } }, select: { storageKey: true } });
  const storage = getStorage();
  let removedObjects = 0;
  for (const f of files) {
    try {
      await storage.delete(f.storageKey);
      removedObjects += 1;
    } catch (e) {
      console.warn(`could not delete object ${f.storageKey}:`, e instanceof Error ? e.message : e);
    }
  }
  const ws = await db.workspace.deleteMany({ where: { id: { in: ids } } });
  const ownEmail = { startsWith: prefix, endsWith: "@hestia.test" };
  // AuthToken rows cascade with the user; deleting them first gives a count.
  const tokens = await db.authToken.deleteMany({ where: { user: { email: ownEmail } } });
  const mails = await db.emailOutbox.deleteMany({ where: { to: ownEmail } });
  const users = await db.user.deleteMany({ where: { email: ownEmail } });
  console.log(
    `[${prefix}] Deleted ${ws.count} workspaces, ${users.count} users, ${tokens.count} auth tokens, ` +
      `${mails.count} outbox mails, ${removedObjects} stored objects.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
