import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// `next dev` gets its own output directory so that a production build
// (npm run build / e2e / smoke) can run while the dev server is open
// without deleting the files the dev server is serving.
export default function config(phase: string): NextConfig {
  return {
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
    // No "X-Powered-By: Next.js". Security headers (CSP with a per-request
    // nonce, HSTS, ...) are set in src/middleware.ts, not here: a static
    // headers() entry cannot carry a nonce, and Next keeps whichever header
    // is set first, which would override route handlers' own stricter values.
    poweredByHeader: false,
  };
}
