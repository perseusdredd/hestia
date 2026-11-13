import type { Page, Response } from "@playwright/test";

import { checkPage, expect, registerWithWorkspace, test } from "./fixtures";

/**
 * Every main page in the project's colour scheme (the *-dark projects run
 * only this spec): layout checks and screenshots via checkPage, plus the
 * security headers. A CSP violation would show up as a "Refused to ..."
 * console message or a securitypolicyviolation event; both fail the test.
 */

const NONCE = /script-src [^;]*'nonce-[A-Za-z0-9+/=_-]{16,}'[^;]*'strict-dynamic'/;

function expectPageCsp(res: Response | null, path: string) {
  expect(res, `no response for ${path}`).not.toBeNull();
  const csp = res!.headers()["content-security-policy"] ?? "";
  expect(csp, `CSP with a nonce on ${path}`).toMatch(NONCE);
  expect(csp, `no unsafe-inline scripts on ${path}`).not.toMatch(/script-src [^;]*'unsafe-inline'/);
  expect(res!.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res!.headers()["x-frame-options"]).toBe("DENY");
}

/** Collects CSP violations (event + console) for the page's whole life. */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction("__cspViolation", (text: string) => violations.push(text));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __cspViolation: (t: string) => void }).__cspViolation(
        `${e.violatedDirective} blocked ${e.blockedURI || "inline"} at ${location.pathname}`,
      );
    });
  });
  page.on("console", (msg) => {
    if (/Refused to/i.test(msg.text())) violations.push(`console.${msg.type()}: ${msg.text()}`);
  });
  return violations;
}

test("every main page: layout, screenshots, CSP with nonce, theme", async ({ newActor }, testInfo) => {
  const dark = testInfo.project.use.colorScheme === "dark";
  const a = await newActor("Tema");
  const { page } = a;
  const violations = await watchCsp(page);

  // Signed out: landing and login.
  for (const [path, name] of [
    ["/", "landing"],
    ["/login", "login"],
  ] as const) {
    const res = await page.goto(path);
    expectPageCsp(res, path);
    await expect(page.locator("html")).toHaveClass(dark ? /\bdark\b/ : /\blight\b/);
    await checkPage(page, testInfo, `theme-${name}`);
  }

  const ws = await registerWithWorkspace(a);
  const pages: [string, string][] = [
    ["", "overview"],
    ["/messages", "messages"],
    ["/messages/new", "messages-new"],
    ["/todos", "todos"],
    ["/files", "files"],
    ["/files/docs/new", "document-new"],
    ["/calendar", "calendar"],
    ["/chat", "chat"],
    ["/activity", "activity"],
    ["/notifications", "notifications"],
    ["/search?q=plan", "search"],
    ["/settings", "settings"],
  ];
  for (const [segment, name] of pages) {
    const path = `/w/${ws.slug}${segment}`;
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    expectPageCsp(res, path);
    await expect(page.locator("html")).toHaveClass(dark ? /\bdark\b/ : /\blight\b/);
    await checkPage(page, testInfo, `theme-${name}`);
  }
  const account = await page.goto("/account");
  expectPageCsp(account, "/account");
  await checkPage(page, testInfo, "theme-account");

  // API responses carry no page CSP (route handlers set their own) and never leak the referrer.
  const health = await page.request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(health.headers()["content-security-policy"]).toBeUndefined();
  expect(health.headers()["referrer-policy"]).toBe("no-referrer");

  expect(violations, "CSP violations").toEqual([]);
});
