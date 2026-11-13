import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Load .env (DATABASE_URL etc.) into the test process. Node >= 20.12.
try {
  process.loadEnvFile(".env");
} catch {
  // .env is optional (CI may provide env vars directly).
}

export default defineConfig({
  // tsconfig uses jsx: preserve (Next); tests that render components need the automatic runtime.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
