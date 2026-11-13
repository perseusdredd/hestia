import { PrismaClient } from "@prisma/client";

/**
 * One PrismaClient per server process.
 *
 * Serverless + Neon (Vercel):
 * - Each warm function instance keeps its own small pool, and many instances
 *   run at once, so the app must talk to Neon's POOLED endpoint (PgBouncer in
 *   transaction mode), never straight to Postgres:
 *     DATABASE_URL = postgresql://USER:PASS@ep-xxx-pooler.REGION.aws.neon.tech/DB
 *                    ?sslmode=require&pgbouncer=true&connection_limit=5&pool_timeout=15&connect_timeout=15
 *   - `-pooler` in the host selects the pooled endpoint.
 *   - `pgbouncer=true` makes Prisma avoid named prepared statements, which a
 *     transaction-mode pooler cannot keep across transactions. (Recent Neon
 *     PgBouncer versions tolerate them, but the flag is the safe default.)
 *   - `connection_limit` is per instance: keep it small (1 to 5). Pages run a
 *     few queries in parallel (Promise.all), so 1 serialises them; 5 times the
 *     instance count must stay well under the pooler's limit, which it does.
 *   - `connect_timeout` covers Neon's cold start after scale-to-zero.
 * - Migrations cannot run through a transaction pooler (advisory locks, DDL),
 *   so prisma/schema.prisma sets `directUrl = env("DIRECT_URL")`: the same
 *   database WITHOUT `-pooler` and without pgbouncer=true. `prisma migrate
 *   deploy` (vercel-build) uses it; the running app never does.
 * - No driver adapter (@prisma/adapter-neon) is used: the Node runtime with
 *   the regular engine over the pooled TCP endpoint is enough for this app.
 *
 * In development the client is kept on globalThis so hot reloads do not open
 * a new pool each time. In production the module scope already gives one
 * client per instance.
 */
const globalForPrisma = globalThis as unknown as { __hestiaPrisma?: PrismaClient };

export const db: PrismaClient =
  globalForPrisma.__hestiaPrisma ??
  new PrismaClient({
    // PRISMA_LOG_QUERIES=1 prints every SQL statement (for counting queries
    // per page while profiling). Off by default.
    log:
      process.env.PRISMA_LOG_QUERIES === "1"
        ? ["query", "warn", "error"]
        : process.env.NODE_ENV === "development"
          ? ["warn", "error"]
          : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__hestiaPrisma = db;
}
