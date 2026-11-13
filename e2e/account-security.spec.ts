import type { Page } from "@playwright/test";

import {
  checkPage,
  createWorkspace,
  expect,
  expectToast,
  login,
  register,
  registerWithWorkspace,
  test,
} from "./fixtures";
import { disconnectOutboxDb, mailedLinkFromDb, mailedLinkFromDevOutbox } from "./outbox";

test.afterAll(async () => {
  await disconnectOutboxDb();
});

const banner = (page: Page) => page.getByRole("region", { name: "Hesap doğrulama uyarısı" });

test("verify email: banner, mailed link from /dev/outbox, banner gone", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const { page } = a;
  await register(a);
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(a.email);
  await checkPage(page, testInfo, "onboarding-unverified");

  // The banner follows into the workspace shell.
  const ws = await createWorkspace(a);
  await expect(banner(page)).toBeVisible();
  await checkPage(page, testInfo, "overview-unverified");

  // /dev/outbox: A's own mail (one verify mail so far).
  const link = await mailedLinkFromDevOutbox(page, "verify-email", "verify-email");
  await expect(page.getByRole("main")).toContainText(a.email);
  await expect(page.locator("article")).toHaveCount(1);
  await checkPage(page, testInfo, "dev-outbox");

  // Opening the link does not verify by itself; the button does.
  await page.goto(new URL(link).pathname);
  await expect(page.getByText("E-posta adresinizi doğrulayın")).toBeVisible();
  await checkPage(page, testInfo, "verify-email");
  await page.goto(`/w/${ws.slug}`);
  await expect(banner(page)).toBeVisible();
  await page.goto(new URL(link).pathname);
  await page.getByRole("button", { name: "E-postamı doğrula" }).click();
  await expect(page.getByRole("status").filter({ hasText: "E-posta adresiniz doğrulandı." })).toBeVisible();

  await page.goto(`/w/${ws.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: ws.name })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);

  // The same link cannot be used twice.
  await page.goto(new URL(link).pathname);
  await page.getByRole("button", { name: "E-postamı doğrula" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Bağlantı geçersiz veya süresi dolmuş" })).toBeVisible();
});

test("forgot and reset password through the UI", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const { page } = a;
  const ws = await registerWithWorkspace(a);

  // Sign out, then "Şifremi unuttum" from the login page.
  await page.getByRole("button", { name: "Hesap menüsü" }).click();
  await page.getByRole("menuitem", { name: "Çıkış yap" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole("link", { name: "Şifremi unuttum" }).click();
  await expect(page).toHaveURL(/\/forgot-password/);
  await checkPage(page, testInfo, "forgot-password");

  // Unknown address: the same confirmation as a real one.
  await page.getByLabel("E-posta").fill(`e2e-unknown-${Date.now()}@hestia.test`);
  await page.getByRole("button", { name: "Sıfırlama bağlantısı gönder" }).click();
  const confirmation = page.getByRole("status");
  await expect(confirmation).toBeVisible();
  const unknownText = await confirmation.innerText();

  await page.goto("/forgot-password");
  await page.getByLabel("E-posta").fill(a.email);
  await page.getByRole("button", { name: "Sıfırlama bağlantısı gönder" }).click();
  await expect(page.getByRole("status")).toHaveText(unknownText);

  // Follow the mailed link.
  const link = await mailedLinkFromDb(a.email, "password-reset", "reset-password");
  await page.goto(new URL(link).pathname);
  await expect(page.getByText("Yeni şifre belirle", { exact: true })).toBeVisible();
  await checkPage(page, testInfo, "reset-password");
  const newPassword = "Sifirlandi-789";
  await page.getByLabel("Yeni şifre").fill(newPassword);
  await page.getByRole("button", { name: "Şifremi güncelle" }).click();
  await expect(page).toHaveURL(/\/login\?reset=1/);
  await expect(page.getByText("Şifreniz güncellendi. Yeni şifrenizle giriş yapın.")).toBeVisible();

  // Old password fails, new one works.
  await page.getByLabel("E-posta").fill(a.email);
  await page.getByLabel("Şifre").fill(a.password);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page.getByText("E-posta veya şifre hatalı.")).toBeVisible();
  await login(a, newPassword);
  await page.goto(`/w/${ws.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: ws.name })).toBeVisible();

  // The link is single-use.
  await page.goto(new URL(link).pathname);
  await page.getByLabel("Yeni şifre").fill("Baska-sifre-000");
  await page.getByRole("button", { name: "Şifremi güncelle" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Bağlantı geçersiz veya süresi dolmuş" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Yeni bağlantı iste" })).toBeVisible();
});

test("changing the password keeps this browser signed in and signs out the other one", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const ws = await registerWithWorkspace(a);

  // Same user, second browser context.
  const other = await newActor("A2");
  other.email = a.email;
  await login(other);
  await other.page.goto(`/w/${ws.slug}`);
  await expect(other.page.getByRole("heading", { level: 1, name: ws.name })).toBeVisible();

  const { page } = a;
  await page.goto("/account");
  const newPassword = "Degisti-321";
  await page.getByLabel("Mevcut şifre").fill(a.password);
  await page.getByLabel("Yeni şifre").fill(newPassword);
  await page.getByRole("button", { name: "Şifreyi değiştir" }).click();
  await expectToast(page, "Şifreniz güncellendi.");

  // This browser got a fresh cookie: reloads and navigation still work.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Hesabım" })).toBeVisible();
  await page.goto(`/w/${ws.slug}/todos`);
  await expect(page).toHaveURL(new RegExp(`/w/${ws.slug}/todos$`));

  // The other browser is signed out with a notice.
  await other.page.goto(`/w/${ws.slug}`);
  await expect(other.page).toHaveURL(/\/login\?expired=1/);
  await expect(other.page.getByText("Oturumunuz sonlandırıldı. Lütfen tekrar giriş yapın.")).toBeVisible();
  await checkPage(other.page, testInfo, "login-expired");
  // ...and can sign in again with the new password.
  await login(other, newPassword);
  await other.page.goto(`/w/${ws.slug}`);
  await expect(other.page.getByRole("heading", { level: 1, name: ws.name })).toBeVisible();
});

test("invite by email: the invited user follows the mailed link", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const b = await newActor("B");
  const ws = await registerWithWorkspace(a);
  await register(b);
  await expect(b.page).toHaveURL(/\/onboarding/);

  await a.page.goto(`/w/${ws.slug}/settings`);
  await a.page.getByLabel("E-posta").fill(b.email);
  await a.page.getByRole("button", { name: "Davet et" }).click();
  await expect(a.page.getByText("Davet e-posta ile de gönderildi.", { exact: false })).toBeVisible();

  // B reads the invite in their own outbox (and nobody else's).
  const link = await mailedLinkFromDevOutbox(b.page, "invite", "invite");
  await expect(b.page.locator('article[data-kind="invite"]').first()).toContainText(ws.name);
  await b.page.goto(new URL(link).pathname);
  await expect(b.page.getByText(ws.name).first()).toBeVisible();
  await checkPage(b.page, testInfo, "invite-from-mail");
  await b.page.getByRole("button", { name: "Daveti kabul et" }).click();
  await expect(b.page).toHaveURL(new RegExp(`/w/${ws.slug}$`));
  await expect(b.page.getByRole("heading", { level: 1, name: ws.name })).toBeVisible();
  // Accepting an invite never verifies the address (the inviter holds the token).
  await expect(banner(b.page)).toHaveCount(1);

  // A's outbox does not contain B's mail.
  await a.page.goto("/dev/outbox");
  await expect(a.page.getByRole("heading", { level: 1, name: "Giden e-postalar" })).toBeVisible();
  await expect(a.page.locator('article[data-kind="invite"]')).toHaveCount(0);
});
