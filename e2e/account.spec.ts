import { checkPage, expect, expectToast, login, registerWithWorkspace, test } from "./fixtures";

test("account: name, password, theme, sign out and back in", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const { page } = a;
  const ws = await registerWithWorkspace(a);

  // Theme from the user menu: dark is applied to <html> and survives a reload
  await page.getByRole("button", { name: "Hesap menüsü" }).click();
  await page.getByRole("menuitemradio", { name: "Koyu" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await checkPage(page, testInfo, "overview-dark");

  // Account page via the user menu
  await page.getByRole("button", { name: "Hesap menüsü" }).click();
  await page.getByRole("menuitem", { name: "Hesabım" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { level: 1, name: "Hesabım" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Koyu" })).toHaveAttribute("aria-checked", "true");
  await checkPage(page, testInfo, "account-dark");
  await page.getByRole("radio", { name: "Açık" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await checkPage(page, testInfo, "account");

  // Name
  const newName = `${a.name} Yılmaz`;
  await page.getByLabel("Ad", { exact: true }).fill(newName);
  await page.getByRole("button", { name: "Kaydet" }).click();
  await expectToast(page, "Adınız güncellendi.");
  await page.reload();
  await expect(page.getByLabel("Ad", { exact: true })).toHaveValue(newName);

  // Wrong current password is rejected
  await page.getByLabel("Mevcut şifre").fill("yanlış-şifre-123");
  await page.getByLabel("Yeni şifre").fill("Yeni-parola-456");
  await page.getByRole("button", { name: "Şifreyi değiştir" }).click();
  await expect(page.getByText(/Mevcut şifre/).nth(1)).toBeVisible();

  // Correct one works
  const newPassword = "Yeni-parola-456";
  await page.getByLabel("Mevcut şifre").fill(a.password);
  await page.getByLabel("Yeni şifre").fill(newPassword);
  await page.getByRole("button", { name: "Şifreyi değiştir" }).click();
  await expectToast(page, "Şifreniz güncellendi.");
  await expect(page.getByLabel("Mevcut şifre")).toHaveValue("");

  // The workspace list on the account page
  await expect(page.getByRole("link", { name: new RegExp(ws.name) }).first()).toBeVisible();

  // Sign out from the workspace shell
  await page.goto(`/w/${ws.slug}`);
  await expect(page.getByRole("button", { name: "Hesap menüsü" })).toBeVisible();
  await page.getByRole("button", { name: "Hesap menüsü" }).click();
  await expect(page.getByRole("menu")).toContainText(newName);
  await page.getByRole("menuitem", { name: "Çıkış yap" }).click();
  await expect(page).toHaveURL(/\/login/);
  await checkPage(page, testInfo, "login");

  // Protected pages now redirect to login
  await page.goto(`/w/${ws.slug}/todos`);
  await expect(page).toHaveURL(/\/login\?callbackUrl=/);

  // Old password fails, new one works
  await page.getByLabel("E-posta").fill(a.email);
  await page.getByLabel("Şifre").fill(a.password);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page.getByText("E-posta veya şifre hatalı.")).toBeVisible();
  await login(a, newPassword);
  await expect(page).toHaveURL(/\/app$/);
  await checkPage(page, testInfo, "app-home");
  await page.getByRole("link", { name: new RegExp(ws.name) }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${ws.slug}$`));
  await expect(page.getByRole("heading", { level: 1, name: ws.name })).toBeVisible();
});
