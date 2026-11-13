import "server-only";

import { headers } from "next/headers";

/** Absolute origin of the current request ("https://app.example.com"). */
export async function getRequestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) {
    const proto =
      h.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
      (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    return `${proto}://${host}`;
  }
  return (process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
}
