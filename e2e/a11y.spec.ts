import AxeBuilder from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";
import type { Page, TestInfo } from "@playwright/test";

import { E2E_PREFIX, expect, isPhone, registerWithWorkspace, test, uid, type Workspace } from "./fixtures";

/**
 * Accessibility: axe-core (WCAG 2.0/2.1 A + AA rules) on every main page and
 * on the interactive states (dialog, dropdown, mention picker, form errors).
 * Runs in all four projects (desktop/phone x light/dark), so contrast is
 * checked in both themes. Any violation fails the test; the attachment
 * "axe-violations" lists them all, grouped by rule.
 *
 * The second test is a keyboard pass over the three most complex widgets:
 * the calendar grid, the @mention picker and the to-do reorder controls.
 */

try {
  process.loadEnvFile(".env");
} catch {
  // env may come from the shell
}

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type Found = { where: string; rule: string; impact: string; targets: string[]; help: string };

async function axe(page: Page, where: string, found: Found[]) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // Let open/close transitions settle so contrast is measured on final colours.
  await page
    .waitForFunction(
      () => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
      undefined,
      { timeout: 3_000 },
    )
    .catch(() => undefined);
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const v of result.violations) {
    found.push({
      where,
      rule: v.id,
      impact: v.impact ?? "",
      help: v.help,
      targets: v.nodes.slice(0, 5).map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.split("\n")[1] ?? ""}`),
    });
  }
}

async function report(found: Found[], testInfo: TestInfo) {
  const byRule: Record<string, number> = {};
  for (const f of found) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  await testInfo.attach("axe-violations", {
    body: JSON.stringify({ byRule, found }, null, 2),
    contentType: "application/json",
  });
  expect(
    found.map((f) => `[${f.where}] ${f.rule} (${f.impact}): ${f.help}\n    ${f.targets.join("\n    ")}`),
    "axe violations",
  ).toEqual([]);
}

let db: PrismaClient | null = null;

type Seed = { postId: string; itemId: string; itemTitles: string[]; eventId: string; docId: string };

/**
 * Content for the pages (lists, detail pages, comments, chat) written straight
 * to the DB: a second member (for @mentions), a post with a comment, a list
 * with three to-dos (one done), an event today, a document, chat messages and
 * a notification. Everything hangs off the e2e-* workspace, so e2e:cleanup
 * removes it.
 */
async function seed(ws: Workspace, ownerEmail: string): Promise<Seed> {
  if (!ws.slug.startsWith(E2E_PREFIX)) throw new Error(`not an e2e workspace: ${ws.slug}`);
  db ??= new PrismaClient();
  const workspace = await db.workspace.findUniqueOrThrow({ where: { slug: ws.slug } });
  const owner = await db.user.findUniqueOrThrow({ where: { email: ownerEmail } });
  const other = await db.user.create({
    data: { name: `Deniz Örnek ${uid(4)}`, email: `${E2E_PREFIX}a11y-${uid()}@hestia.test` },
  });
  await db.membership.create({ data: { workspaceId: workspace.id, userId: other.id, role: "MEMBER" } });
  const w = workspace.id;
  const post = await db.post.create({
    data: { workspaceId: w, authorId: other.id, title: "Haftalık plan", body: "Bu hafta **tasarım** turu var.\n\n- Logo\n- Renkler" },
  });
  await db.comment.create({
    data: { workspaceId: w, postId: post.id, authorId: other.id, body: `Harika, @[${owner.name}](user:${owner.id}) bakar mısınız?` },
  });
  const list = await db.todoList.create({ data: { workspaceId: w, createdById: owner.id, name: "Lansman" } });
  const itemTitles = ["Metinleri yaz", "Görselleri hazırla", "Yayın tarihini seç"];
  const items = [];
  for (const [i, title] of itemTitles.entries()) {
    items.push(
      await db.todoItem.create({
        data: {
          workspaceId: w,
          listId: list.id,
          createdById: owner.id,
          assigneeId: i === 0 ? owner.id : other.id,
          title,
          position: i,
          status: i === 2 ? "DONE" : "OPEN",
          completedAt: i === 2 ? new Date() : null,
          dueDate: i === 0 ? new Date(new Date().toISOString().slice(0, 10)) : null,
        },
      }),
    );
  }
  await db.comment.create({ data: { workspaceId: w, todoItemId: items[0].id, authorId: other.id, body: "Taslak hazır." } });
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const event = await db.event.create({
    data: {
      workspaceId: w,
      createdById: owner.id,
      title: "Müşteri görüşmesi",
      location: "Kadıköy",
      startsAt: start,
      endsAt: new Date(start.getTime() + 60 * 60 * 1000),
    },
  });
  const doc = await db.document.create({
    data: { workspaceId: w, authorId: owner.id, title: "Marka rehberi", content: "# Marka\n\nRenkler ve **yazı tipleri**.\n\n| Ad | Değer |\n| --- | --- |\n| Ana | Kiremit |" },
  });
  await db.chatMessage.createMany({
    data: [
      { workspaceId: w, authorId: other.id, body: "Günaydın! https://example.com" },
      { workspaceId: w, authorId: owner.id, body: "Günaydın, toplantı 14:00'te." },
    ],
  });
  await db.notification.create({
    data: {
      workspaceId: w,
      userId: owner.id,
      actorId: other.id,
      type: "MENTION",
      title: "Deniz sizden bahsetti",
      body: "Harika, bakar mısınız?",
      path: `/w/${ws.slug}/messages/${post.id}`,
    },
  });
  return { postId: post.id, itemId: items[0].id, itemTitles, eventId: event.id, docId: doc.id };
}

test.afterAll(async () => {
  await db?.$disconnect();
});

test("axe: every main page and interactive state has no WCAG 2.1 A/AA violations", async ({ newActor }, testInfo) => {
  test.setTimeout(240_000);
  const found: Found[] = [];
  const a = await newActor("Erisim");
  const { page } = a;

  // ---- Signed out
  for (const path of ["/", "/login", "/register", "/forgot-password"]) {
    await page.goto(path);
    await axe(page, path, found);
  }
  // Form error state: wrong credentials.
  await page.goto("/login");
  await page.getByLabel("E-posta").fill(`${E2E_PREFIX}yok-${uid()}@hestia.test`);
  await page.getByLabel("Şifre").fill("yanlis-parola-123");
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await axe(page, "/login (error)", found);
  // Field errors: empty registration.
  await page.goto("/register");
  await page.getByRole("button", { name: "Hesap oluştur" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await axe(page, "/register (field errors)", found);

  // ---- Signed in
  const ws = await registerWithWorkspace(a);
  const s = await seed(ws, a.email);
  const base = `/w/${ws.slug}`;
  const pages = [
    "",
    "/messages",
    `/messages/${s.postId}`,
    "/messages/new",
    "/todos",
    `/todos/${s.itemId}`,
    "/files",
    "/files/docs/new",
    `/files/docs/${s.docId}`,
    "/calendar",
    `/calendar/${s.eventId}`,
    "/chat",
    "/activity",
    "/notifications",
    "/search?q=plan",
    "/settings",
  ];
  for (const segment of pages) {
    const res = await page.goto(base + segment);
    expect(res?.status(), base + segment).toBe(200);
    await axe(page, base + segment, found);
  }
  for (const path of ["/account", "/app", "/onboarding"]) {
    await page.goto(path);
    await axe(page, path, found);
  }

  // ---- States
  // Dropdown open: the account menu.
  await page.goto(base);
  await page.getByRole("button", { name: "Hesap menüsü" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await axe(page, "overview (account menu open)", found);
  await page.keyboard.press("Escape");

  // Dialog open: new event.
  await page.goto(`${base}/calendar`);
  await page.getByRole("button", { name: "Yeni etkinlik" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await axe(page, "calendar (event dialog open)", found);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Mention picker open in a comment.
  await page.goto(`${base}/messages/${s.postId}`);
  const comment = page.getByLabel("Yorum ekle");
  await comment.click();
  await comment.pressSequentially("Merhaba @De");
  await expect(page.getByRole("listbox", { name: "Bahsedilecek üye" })).toBeVisible();
  await axe(page, "post (mention picker open)", found);

  // Form errors: empty new post.
  await page.goto(`${base}/messages/new`);
  await page.getByRole("button", { name: "Yayınla" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await axe(page, "messages/new (field errors)", found);

  // Phone: the to-do row menu open.
  if (isPhone(testInfo)) {
    await page.goto(`${base}/todos`);
    await page.getByRole("button", { name: `"${s.itemTitles[0]}" için işlemler` }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await axe(page, "todos (row menu open)", found);
    await page.keyboard.press("Escape");
  }

  await report(found, testInfo);
});

test("keyboard: calendar grid, mention picker and to-do reordering work without a mouse", async ({ newActor }, testInfo) => {
  test.skip(testInfo.project.use.colorScheme === "dark", "keyboard behaviour does not depend on the theme");
  const a = await newActor("Klavye");
  const { page } = a;
  const ws = await registerWithWorkspace(a);
  const s = await seed(ws, a.email);
  const base = `/w/${ws.slug}`;

  // ---- Skip link: the first Tab stop, lands in <main>.
  await page.goto(`${base}/todos`);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "İçeriğe geç" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();

  // ---- Calendar: the day grid is one tab stop; arrows move by day / week.
  await page.goto(`${base}/calendar`);
  const grid = page.getByRole("region", { name: "Ay görünümü" });
  const days = grid.locator("button[data-day]");
  await expect(days.and(page.locator("[tabindex='0']"))).toHaveCount(1);
  const start = grid.locator("button[data-day][tabindex='0']");
  const startKey = await start.getAttribute("data-day");
  await start.focus();
  const keys = await days.evaluateAll((els) => els.map((e) => e.getAttribute("data-day")));
  const at = keys.indexOf(startKey);
  const move = at + 7 < keys.length ? "ArrowDown" : "ArrowUp";
  await page.keyboard.press(move);
  const expected = keys[move === "ArrowDown" ? at + 7 : at - 7];
  await expect(grid.locator(`button[data-day="${expected}"]`)).toBeFocused();
  await page.keyboard.press(at % 7 === 6 ? "ArrowLeft" : "ArrowRight");
  const sideways = keys[(move === "ArrowDown" ? at + 7 : at - 7) + (at % 7 === 6 ? -1 : 1)];
  await expect(grid.locator(`button[data-day="${sideways}"]`)).toBeFocused();
  await expect(grid.locator(`button[data-day="${sideways}"]`)).toHaveAttribute("tabindex", "0");
  // Enter opens the dialog for that day; Escape closes it and focus returns to the day.
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Yeni etkinlik" })).toBeVisible();
  await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(grid.locator(`button[data-day="${sideways}"]`)).toBeFocused();
  // Tab leaves the grid (no trap): focus moves past the 42 days in one press,
  // to an event chip or the agenda.
  await page.keyboard.press("Tab");
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-day"))).toBe(false);

  // ---- Mention picker: arrows, Enter inserts, Escape closes only the list.
  await page.goto(`${base}/todos/${s.itemId}`);
  const box = page.getByLabel("Yorum ekle");
  await box.focus();
  await page.keyboard.type("Bakın @De");
  const listbox = page.getByRole("listbox", { name: "Bahsedilecek üye" });
  await expect(listbox).toBeVisible();
  await expect(box).toHaveAttribute("aria-activedescendant", /.+/);
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(box).toBeFocused();
  // Typing on keeps it closed for this "@"; deleting the "@" and typing a new one reopens it.
  await page.keyboard.type("n");
  await expect(listbox).toBeHidden();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("@Den");
  await expect(listbox).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(listbox).toBeHidden();
  await expect(box).toHaveValue(/@\[Deniz Örnek [^\]]+\]\(user:[^)]+\) $/);
  // Tab leaves the editor (the list is closed).
  await page.keyboard.press("Tab");
  await expect(box).not.toBeFocused();

  // ---- To-do reordering with the keyboard only.
  await page.goto(`${base}/todos`);
  const [first, second] = s.itemTitles;
  const rows = page.locator("li").filter({ has: page.getByRole("checkbox") });
  await expect(rows.first()).toContainText(first);
  if (isPhone(testInfo)) {
    // Phones: the row's "…" menu. Open it with Enter, arrow to "Aşağı taşı".
    const trigger = page.getByRole("button", { name: `"${first}" için işlemler` });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect.poll(() => menu.evaluate((m) => m.contains(document.activeElement))).toBe(true);
    // Escape closes and returns focus to the trigger.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    for (let i = 0; i < 4; i++) {
      const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
      if (focused === "Aşağı taşı") break;
      await page.keyboard.press("ArrowDown");
    }
    await expect(menu.getByRole("menuitem", { name: "Aşağı taşı" })).toBeFocused();
    await page.keyboard.press("Enter");
  } else {
    const down = page.getByRole("button", { name: `"${first}" görevini aşağı taşı` });
    await down.focus();
    await expect(down).toBeFocused();
    await page.keyboard.press("Enter");
  }
  await expect(rows.first()).toContainText(second);
  await expect(rows.nth(1)).toContainText(first);
  // Focus is not dropped on <body> after the move.
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});
