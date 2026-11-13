/**
 * Runs once when the server starts. Validating the environment here makes a
 * misconfigured deployment fail at boot instead of only showing up in the
 * /api/health logs.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") (await import("@/lib/env")).getServerEnv();
}
