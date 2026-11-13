import { defineConfig, devices } from "@playwright/test";

/**
 * Real-browser end-to-end tests against the production build.
 *
 *   npm run e2e            # builds, starts `next start -p 3230`, runs every project
 *   npm run e2e:cleanup    # deletes the e2e-* users, workspaces, tokens and outbox mails
 *
 * E2E_REUSE=1 reuses a server that is already listening on 3230 (faster local
 * iteration); without it Playwright builds and starts its own.
 *
 * Projects: "desktop" and "phone" run the whole suite in the light scheme;
 * "desktop-dark" and "phone-dark" run only themes.spec.ts (every main page,
 * layout checks and screenshots) and a11y.spec.ts (axe on every page and
 * state, so contrast is checked in both themes) with prefers-color-scheme: dark.
 */
const PORT = 3230;
const BASE_URL = `http://localhost:${PORT}`;

const DESKTOP = {
  ...devices["Desktop Chrome"],
  viewport: { width: 1280, height: 800 },
  timezoneId: "Europe/Istanbul",
  colorScheme: "light" as const,
};
// A browser far from Istanbul: dates are pinned to Istanbul on the server, so
// any client/server disagreement shows up as a hydration error.
const PHONE = { ...devices["Pixel 7"], timezoneId: "America/New_York", colorScheme: "light" as const };
const THEME_SPEC = /(themes|a11y)\.spec\.ts$/;

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { outputFolder: "e2e/.report", open: "never" }]],
  use: {
    baseURL: BASE_URL,
    locale: "tr-TR",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "desktop", use: DESKTOP },
    { name: "phone", use: PHONE },
    { name: "desktop-dark", use: { ...DESKTOP, colorScheme: "dark" }, testMatch: THEME_SPEC },
    { name: "phone-dark", use: { ...PHONE, colorScheme: "dark" }, testMatch: THEME_SPEC },
  ],
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `${BASE_URL}/login`,
    reuseExistingServer: Boolean(process.env.E2E_REUSE),
    timeout: 600_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      AUTH_URL: BASE_URL,
      AUTH_TRUST_HOST: "true",
      ALLOW_LOCAL_STORAGE: "true",
      // /dev/outbox on the production build: the suite reads mailed links there.
      ENABLE_DEV_OUTBOX: "true",
      MAIL_DRIVER: "outbox",
      CRON_SECRET: "e2e-cron-secret-0123456789",
    },
  },
});
