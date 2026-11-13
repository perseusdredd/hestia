import { PrismaClient } from "@prisma/client";

import type { Page } from "@playwright/test";

import { expect } from "./fixtures";

/*
 * Mailed links for the browser suite. A signed-in actor reads its own mail
 * through /dev/outbox (the server runs with ENABLE_DEV_OUTBOX=true); a
 * signed-out one (forgot password) needs the DB, like scripts/smoke-outbox.ts.
 */

try {
  process.loadEnvFile(".env");
} catch {
  // env may come from the shell
}

let db: PrismaClient | null = null;

/** The newest `/<route>/<token>` link mailed to an e2e-* address, polled until it appears. */
export async function mailedLinkFromDb(to: string, kind: string, route: string): Promise<string> {
  if (!to.startsWith("e2e-") || !to.endsWith("@hestia.test")) throw new Error(`not an e2e address: ${to}`);
  db ??= new PrismaClient();
  const client = db;
  let link = "";
  await expect
    .poll(
      async () => {
        const row = await client.emailOutbox.findFirst({
          where: { to: to.toLowerCase(), kind },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { text: true },
        });
        link = new RegExp(`https?://\\S+/${route}/[A-Za-z0-9_-]+`).exec(row?.text ?? "")?.[0] ?? "";
        return link;
      },
      { message: `${kind} mail to ${to}`, timeout: 10_000 },
    )
    .not.toBe("");
  return link;
}

export async function disconnectOutboxDb() {
  await db?.$disconnect();
  db = null;
}

/** Open /dev/outbox as the signed-in actor and return the newest link of `kind` to `route`. */
export async function mailedLinkFromDevOutbox(page: Page, kind: string, route: string): Promise<string> {
  await page.goto("/dev/outbox");
  await expect(page.getByRole("heading", { level: 1, name: "Giden e-postalar" })).toBeVisible();
  const mail = page.locator(`article[data-kind="${kind}"]`).first();
  await expect(mail).toBeVisible();
  const href = await mail.getByRole("link", { name: new RegExp(`/${route}/`) }).first().getAttribute("href");
  expect(href, `${kind} link in /dev/outbox`).toMatch(new RegExp(`/${route}/[A-Za-z0-9_-]+$`));
  return href as string;
}
