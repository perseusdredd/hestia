import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { test as base, expect, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";

/**
 * Shared fixtures for the browser suite.
 *
 * - Every user acts in its own browser context ("actor"), created with the
 *   project's device options and a distinct X-Forwarded-For so the per-IP
 *   auth rate limits treat each actor like a different client.
 * - Every page of every actor is watched: console errors, page errors and
 *   React hydration warnings fail the test at teardown.
 * - Emails and workspace slugs start with "e2e-" so `npm run e2e:cleanup`
 *   can delete them.
 */

export const E2E_PREFIX = "e2e-";
export const PASSWORD = "Parola-e2e-123";

export function uid(len = 8): string {
  let s = "";
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len);
}

export type Actor = {
  label: string;
  name: string;
  email: string;
  password: string;
  context: BrowserContext;
  page: Page;
  /** Console messages matching one of these do not fail the test. */
  allow: RegExp[];
};

type Problem = { actor: string; kind: string; text: string; url: string };

const HYDRATION = /hydrat|did not match|server rendered|Minified React error #(418|423|425)/i;

function watch(page: Page, actor: Actor, problems: Problem[]) {
  page.on("console", (msg) => {
    const type = msg.type();
    const text = msg.text();
    const isError = type === "error";
    const isHydrationWarning = type === "warning" && HYDRATION.test(text);
    if (!isError && !isHydrationWarning) return;
    if (actor.allow.some((r) => r.test(text))) return;
    problems.push({ actor: actor.label, kind: `console.${type}`, text, url: page.url() });
  });
  page.on("pageerror", (err) => {
    problems.push({ actor: actor.label, kind: "pageerror", text: `${err.name}: ${err.message}`, url: page.url() });
  });
}

type Fixtures = {
  newActor: (label: string) => Promise<Actor>;
};

export const test = base.extend<Fixtures>({
  // The fixture callback is named `provide` (not `use`) so the React hooks lint rule leaves it alone.
  newActor: async ({ browser }, provide, testInfo) => {
    const problems: Problem[] = [];
    const actors: Actor[] = [];
    const contextOptions = deviceOptions(testInfo);

    await provide(async (label: string) => {
      const context = await browser.newContext({
        ...contextOptions,
        acceptDownloads: true,
        extraHTTPHeaders: { "x-forwarded-for": `10.${rnd()}.${rnd()}.${rnd()}` },
      });
      const id = uid();
      const actor: Actor = {
        label,
        name: `E2E ${label} ${id}`,
        email: `${E2E_PREFIX}${label.toLowerCase()}-${id}@hestia.test`,
        password: PASSWORD,
        context,
        page: undefined as unknown as Page,
        allow: [],
      };
      context.on("page", (p) => watch(p, actor, problems));
      actor.page = await context.newPage();
      actors.push(actor);
      return actor;
    });

    for (const a of actors) await a.context.close().catch(() => undefined);
    if (problems.length) {
      await testInfo.attach("browser-problems", {
        body: JSON.stringify(problems, null, 2),
        contentType: "application/json",
      });
    }
    expect(
      problems.map((p) => `[${p.actor}] ${p.kind} at ${p.url}: ${p.text}`),
      "browser console errors / page errors / hydration warnings",
    ).toEqual([]);
  },
});

function rnd() {
  return Math.floor(Math.random() * 250) + 1;
}

/** The project's device options, so manual contexts match the project (desktop / Pixel 7). */
function deviceOptions(testInfo: TestInfo) {
  const u = testInfo.project.use;
  return {
    viewport: u.viewport,
    userAgent: u.userAgent,
    deviceScaleFactor: u.deviceScaleFactor,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    locale: u.locale,
    timezoneId: u.timezoneId,
    colorScheme: u.colorScheme,
    baseURL: u.baseURL,
  };
}

/** "phone" and "phone-dark" (Pixel 7, coarse pointer). */
export const isPhone = (testInfo: TestInfo) => testInfo.project.name.startsWith("phone");

export { expect };

// --------------------------------------------------------------- flows ----

export async function register(actor: Actor, path = "/register") {
  const { page } = actor;
  await page.goto(path);
  await page.getByLabel("Ad soyad").fill(actor.name);
  await page.getByLabel("E-posta").fill(actor.email);
  await page.getByLabel("Şifre").fill(actor.password);
  await page.getByRole("button", { name: "Hesap oluştur" }).click();
  await expect(page).not.toHaveURL(/\/register/, { timeout: 20_000 });
}

export async function login(actor: Actor, password = actor.password) {
  const { page } = actor;
  await page.goto("/login");
  await page.getByLabel("E-posta").fill(actor.email);
  await page.getByLabel("Şifre").fill(password);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
}

export type Workspace = { name: string; slug: string };

/** From /onboarding (where a fresh user lands) create a workspace and land on its overview. */
export async function createWorkspace(actor: Actor, label = "Takım"): Promise<Workspace> {
  const { page } = actor;
  const id = uid(6);
  const ws = { name: `E2E ${label} ${id}`, slug: `${E2E_PREFIX}${id}` };
  if (!page.url().includes("/onboarding")) await page.goto("/onboarding");
  await page.getByLabel("Çalışma alanı adı").fill(ws.name);
  const slug = page.getByLabel("Adres");
  await slug.fill(ws.slug);
  await page.getByRole("button", { name: "Çalışma alanını oluştur" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${ws.slug}$`), { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: ws.name })).toBeVisible();
  return ws;
}

export async function registerWithWorkspace(actor: Actor, label?: string) {
  await register(actor);
  await expect(actor.page).toHaveURL(/\/onboarding/);
  return createWorkspace(actor, label);
}

/** Primary workspace navigation; on phones it is the scrollable pill strip. */
export async function nav(page: Page, label: string) {
  await page
    .getByRole("navigation", { name: "Çalışma alanı" })
    .filter({ visible: true })
    .getByRole("link", { name: label, exact: true })
    .click();
}

// ------------------------------------------------------------- checks ----

export async function expectNoHorizontalOverflow(page: Page) {
  const m = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    offenders: [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .filter((el) => !el.closest("[data-overflow-ok], nav"))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)}`),
  }));
  expect(
    m.scrollWidth,
    `horizontal overflow on ${page.url()}: scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}; widest: ${m.offenders.join(" | ")}`,
  ).toBeLessThanOrEqual(m.clientWidth);
}

/** Minimum touch target (CSS px) for controls on phones. */
const MIN_TAP = 40;

/**
 * Every visible button-like control must be at least MIN_TAP tall and wide.
 * Checkboxes are exempt (their hit area is an ::after overlay); so are plain
 * text links inside prose.
 */
export async function expectTapTargets(page: Page) {
  const small = await page.evaluate((min) => {
    const selector = [
      "button",
      "a[data-slot=button]",
      "a[class*='inline-flex'][class*='rounded']",
      "[role=menuitem]",
      "[role=menuitemradio]",
      "select",
      "input:not([type=hidden]):not([type=checkbox]):not([type=file])",
    ].join(",");
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => el.getAttribute("role") !== "checkbox" && !el.closest("[data-sonner-toaster]"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || style.visibility === "hidden" || style.opacity === "0") return false;
        if (el.classList.contains("sr-only")) return false;
        return r.height < min - 0.5 || r.width < min - 0.5;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const label = (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40);
        return `${el.tagName.toLowerCase()} "${label}" ${Math.round(r.width)}x${Math.round(r.height)}`;
      });
  }, MIN_TAP);
  // Soft: report every page's offenders in one run; the test still fails.
  expect.soft(small, `tap targets under ${MIN_TAP}px on ${page.url()}`).toEqual([]);
}

const SHOTS = join(process.cwd(), "e2e", "screenshots");

/** Overflow check plus a full-page screenshot under e2e/screenshots/<project>/<name>.png. */
export async function checkPage(page: Page, testInfo: TestInfo, name: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // Let open/close transitions (dialog zoom-in etc.) finish before measuring;
  // infinite spinners never finish, so this is best effort.
  await page
    .waitForFunction(
      () => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
      undefined,
      { timeout: 3_000 },
    )
    .catch(() => undefined);
  await expectNoHorizontalOverflow(page);
  if (isPhone(testInfo)) await expectTapTargets(page);
  const dir = join(SHOTS, testInfo.project.name);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

/** Wait for a sonner toast with the given text. */
export async function expectToast(page: Page, text: string | RegExp) {
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: text }).first()).toBeVisible();
}

const TODO_BUTTON = {
  up: (t: string) => `"${t}" görevini yukarı taşı`,
  down: (t: string) => `"${t}" görevini aşağı taşı`,
  edit: (t: string) => `"${t}" görevini düzenle`,
  delete: (t: string) => `"${t}" görevini sil`,
} as const;
const TODO_MENU_ITEM = { up: "Yukarı taşı", down: "Aşağı taşı", edit: "Düzenle", delete: "Sil" } as const;

/**
 * Run a to-do row action. Desktop (fine pointer) rows show one button per
 * action; phones collapse them into the row's "… için işlemler" menu.
 */
export async function todoAction(
  page: Page,
  scope: Page | Locator,
  title: string,
  action: keyof typeof TODO_BUTTON,
  testInfo: TestInfo,
) {
  if (isPhone(testInfo)) {
    await expect(scope.getByRole("button", { name: TODO_BUTTON[action](title) })).toBeHidden();
    await scope.getByRole("button", { name: `"${title}" için işlemler` }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: TODO_MENU_ITEM[action], exact: true }).click();
  } else {
    await expect(scope.getByRole("button", { name: `"${title}" için işlemler` })).toBeHidden();
    await scope.getByRole("button", { name: TODO_BUTTON[action](title) }).click();
  }
}
