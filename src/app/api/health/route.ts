import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { EnvValidationError, getServerEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DB_TIMEOUT_MS = 2_000;
const HEADERS = { "Cache-Control": "no-store, max-age=0" } as const;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Public uptime probe. Answers only { status, db }: no versions, hosts or
 * error text. 200 when the database answers a trivial query in time, 503 otherwise.
 */
export async function GET() {
  try {
    getServerEnv();
  } catch (e) {
    // Logged for the operator only; the public answer stays { status, db }.
    if (e instanceof EnvValidationError) console.error(`[health] ${e.message}`);
    else throw e;
  }
  try {
    await withTimeout(db.$queryRaw`SELECT 1`, DB_TIMEOUT_MS);
    return NextResponse.json({ status: "ok", db: "ok" }, { headers: HEADERS });
  } catch (e) {
    console.error("[health] database check failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ status: "error", db: "error" }, { status: 503, headers: HEADERS });
  }
}
