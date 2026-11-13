import type { Page } from "@playwright/test";

import { checkPage, expect, expectToast, nav, registerWithWorkspace, test, todoAction } from "./fixtures";

function card(page: Page, listName: string) {
  return page
    .locator("[data-slot=card]")
    .filter({ has: page.getByRole("heading", { level: 2, name: listName, exact: true }) });
}

async function createList(page: Page, name: string) {
  await page.getByRole("button", { name: "Yeni liste" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Yeni liste" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Liste adı").fill(name);
  await dialog.getByRole("button", { name: "Oluştur" }).click();
  await expectToast(page, "Liste oluşturuldu.");
  await expect(dialog).toBeHidden();
  await expect(card(page, name)).toBeVisible();
}

async function addItem(page: Page, listName: string, title: string) {
  const c = card(page, listName);
  const input = c.getByLabel("Yeni görev başlığı");
  await input.fill(title);
  await c.getByRole("button", { name: "Görevi ekle" }).click();
  await expect(c.getByText(title, { exact: true })).toBeVisible();
  await expect(input).toHaveValue("");
}

/** ISO date `days` from today (browser-independent, good enough for a due date). */
function isoInDays(days: number) {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

test("to-do lists: create, add, toggle, edit, reorder, move, delete", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const { page } = a;
  await registerWithWorkspace(a);

  await nav(page, "Yapılacaklar");
  await expect(page.getByRole("heading", { level: 1, name: "Yapılacaklar" })).toBeVisible();
  await expect(page.getByText("Henüz liste yok")).toBeVisible();
  await checkPage(page, testInfo, "todos-empty");

  await createList(page, "Sprint 1");
  await createList(page, "Sprint 2");

  for (const t of ["Görev A", "Görev B", "Görev C"]) await addItem(page, "Sprint 1", t);
  const s1 = card(page, "Sprint 1");
  await expect(s1.getByRole("listitem")).toHaveCount(3);

  // Reorder: B up -> B, A, C. The row moves optimistically, so keep hold of
  // the server action's response and let it finish before the reload below.
  const moved = page.waitForResponse((r) => r.request().method() === "POST" && Boolean(r.request().headers()["next-action"]));
  await todoAction(page, s1, "Görev B", "up", testInfo);
  await expect(s1.getByRole("listitem").first()).toContainText("Görev B");
  await expect(s1.getByRole("listitem").nth(1)).toContainText("Görev A");
  await (await moved).finished();

  // Reload keeps the order (it was saved, not only optimistic)
  await page.reload();
  await expect(s1.getByRole("listitem").first()).toContainText("Görev B");

  // Toggle done
  await s1.getByRole("checkbox", { name: '"Görev A": tamamlandı olarak işaretle' }).click();
  await expect(s1.getByText("1/3 tamamlandı")).toBeVisible();
  await expect(s1.getByText("Tamamlananlar (1)")).toBeVisible();
  await page.reload();
  await expect(s1.getByText("1/3 tamamlandı")).toBeVisible();

  // Edit: assignee + due date
  await todoAction(page, s1, "Görev C", "edit", testInfo);
  let dialog = page.getByRole("dialog", { name: "Görevi düzenle" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Notlar").fill("Müşteriyle görüşmeden önce bitmeli.");
  await dialog.getByLabel("Atanan kişi").selectOption({ label: a.name });
  const due = isoInDays(10);
  await dialog.getByLabel("Bitiş tarihi").fill(due);
  await dialog.getByRole("button", { name: "Kaydet" }).click();
  await expectToast(page, "Görev güncellendi.");
  await expect(dialog).toBeHidden();
  const rowC = s1.getByRole("listitem").filter({ hasText: "Görev C" });
  await expect(rowC).toContainText(a.name);
  await expect(rowC).toContainText("Müşteriyle görüşmeden önce bitmeli.");
  await checkPage(page, testInfo, "todos-lists");

  // Assigned-to-me filter
  await page.getByRole("link", { name: "Bana atananlar" }).click();
  await expect(page).toHaveURL(/mine=1/);
  await expect(page.getByText("Görev C", { exact: true })).toBeVisible();
  await expect(page.getByText("Görev B", { exact: true })).toBeHidden();
  await page.getByRole("link", { name: "Tümü", exact: true }).click();
  await expect(page.getByText("Görev B", { exact: true })).toBeVisible();

  // Move B to the other list
  await todoAction(page, s1, "Görev B", "edit", testInfo);
  dialog = page.getByRole("dialog", { name: "Görevi düzenle" });
  await dialog.getByLabel("Listeye taşı").selectOption({ label: "Sprint 2" });
  await dialog.getByRole("button", { name: "Kaydet" }).click();
  await expectToast(page, "Görev güncellendi.");
  await expect(dialog).toBeHidden();
  await expect(card(page, "Sprint 2").getByText("Görev B", { exact: true })).toBeVisible();
  await expect(s1.getByText("Görev B", { exact: true })).toBeHidden();

  // Delete C
  await todoAction(page, s1, "Görev C", "delete", testInfo);
  const confirm = page.getByRole("dialog", { name: "Görev silinsin mi?" });
  await confirm.getByRole("button", { name: "Sil" }).click();
  await expectToast(page, "Görev silindi.");
  await expect(confirm).toBeHidden();
  await expect(s1.getByText("Görev C", { exact: true })).toBeHidden();

  // Rename and delete a list
  await card(page, "Sprint 2").getByRole("button", { name: "Listeyi düzenle" }).click();
  dialog = page.getByRole("dialog", { name: "Listeyi düzenle" });
  await dialog.getByLabel("Liste adı").fill("Arşiv");
  await dialog.getByRole("button", { name: "Kaydet" }).click();
  await expectToast(page, "Liste güncellendi.");
  await card(page, "Arşiv").getByRole("button", { name: "Listeyi sil" }).click();
  const listConfirm = page.getByRole("dialog", { name: "Liste silinsin mi?" });
  await listConfirm.getByRole("button", { name: "Listeyi sil" }).click();
  await expectToast(page, "Liste silindi.");
  await expect(card(page, "Arşiv")).toHaveCount(0);
  await expect(card(page, "Sprint 1")).toBeVisible();
});
