/**
 * Prints the newest EmailOutbox rows addressed to one smoke/e2e test address
 * as JSON (one array on stdout), so the HTTP smoke test can follow mailed
 * links without SMTP.
 *
 *   npx tsx scripts/smoke-outbox.ts smoke-d-xyz@hestia.test [kind]
 *
 * Only <smoke-|e2e->*@hestia.test addresses are accepted.
 */
import { PrismaClient } from "@prisma/client";

try {
  process.loadEnvFile(".env");
} catch {
  // env may come from the shell
}

const [to, kind] = process.argv.slice(2);
if (!to || !/^(smoke-|e2e-)[^@\s]+@hestia\.test$/.test(to)) {
  console.error("Usage: tsx scripts/smoke-outbox.ts <smoke-*|e2e-*>@hestia.test [kind]");
  process.exit(1);
}

const db = new PrismaClient();

db.emailOutbox
  .findMany({
    where: { to: to.toLowerCase(), ...(kind ? { kind } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
    select: { id: true, to: true, kind: true, subject: true, text: true, createdAt: true },
  })
  .then((rows) => {
    process.stdout.write(JSON.stringify(rows));
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
