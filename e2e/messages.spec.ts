import { checkPage, expect, expectToast, nav, registerWithWorkspace, test } from "./fixtures";

test("register, onboarding and the message board", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const { page } = a;

  await page.goto("/register");
  await checkPage(page, testInfo, "register");
  const ws = await registerWithWorkspace(a);
  await checkPage(page, testInfo, "overview-empty");

  await nav(page, "Mesajlar");
  await expect(page.getByRole("heading", { level: 1, name: "Mesajlar" })).toBeVisible();
  await expect(page.getByText("Henüz mesaj yok")).toBeVisible();
  await checkPage(page, testInfo, "messages-empty");

  // Create
  await page.getByRole("link", { name: "Yeni mesaj" }).first().click();
  await expect(page).toHaveURL(/\/messages\/new$/);
  await checkPage(page, testInfo, "messages-new");
  await page.getByLabel("Başlık").fill("Haftalık güncelleme");
  await page.getByLabel("Mesaj").fill("Bu hafta yayına çıkıyoruz. Ayrıntılar: https://example.com/plan");
  await page.getByRole("button", { name: "Yayınla" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${ws.slug}/messages/[^/]+$`));
  await expect(page.getByRole("heading", { level: 1, name: "Haftalık güncelleme" })).toBeVisible();
  await expect(page.getByRole("link", { name: "https://example.com/plan" })).toBeVisible();

  // Comment
  await page.getByLabel("Yorum ekle").fill("Harika, elinize sağlık!");
  await page.getByRole("button", { name: "Yorum yap" }).click();
  await expectToast(page, "Yorum eklendi.");
  await expect(page.getByRole("heading", { name: "Yorumlar (1)" })).toBeVisible();
  await expect(page.getByText("Harika, elinize sağlık!")).toBeVisible();
  await expect(page.getByLabel("Yorum ekle")).toHaveValue("");

  // Edit the comment
  const comments = page.getByRole("region", { name: /Yorumlar/ }).getByRole("listitem");
  await comments.first().getByRole("button", { name: "Düzenle" }).click();
  await page.getByRole("textbox", { name: "Yorum", exact: true }).fill("Harika, düzenlendi.");
  await comments.first().getByRole("button", { name: "Kaydet" }).click();
  await expectToast(page, "Yorum güncellendi.");
  await expect(page.getByText("Harika, düzenlendi.")).toBeVisible();

  // Edit the post
  await page.getByRole("button", { name: "Düzenle" }).first().click();
  await page.getByLabel("Başlık").fill("Haftalık güncelleme (revize)");
  await page.getByRole("button", { name: "Kaydet" }).click();
  await expectToast(page, "Gönderi güncellendi.");
  await expect(page.getByRole("heading", { level: 1, name: "Haftalık güncelleme (revize)" })).toBeVisible();

  // Pin, unpin
  await page.getByRole("button", { name: "Sabitle" }).click();
  await expectToast(page, "Gönderi sabitlendi.");
  await expect(page.getByText("Sabit", { exact: true })).toBeVisible();
  await checkPage(page, testInfo, "message-detail");
  await page.getByRole("button", { name: "Sabitlemeyi kaldır" }).click();
  await expectToast(page, "Sabitleme kaldırıldı.");
  await expect(page.getByRole("button", { name: "Sabitle" })).toBeVisible();

  // The list shows it
  await page.getByRole("link", { name: "Mesajlar", exact: true }).first().click();
  await expect(page.getByRole("link", { name: /Haftalık güncelleme \(revize\)/ })).toBeVisible();
  await checkPage(page, testInfo, "messages-list");

  // Delete the comment, then the post
  await page.getByRole("link", { name: /Haftalık güncelleme \(revize\)/ }).click();
  await comments.first().getByRole("button", { name: "Sil" }).click();
  const confirm = page.getByRole("dialog", { name: "Yorum silinsin mi?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Sil" }).click();
  await expectToast(page, "Yorum silindi.");
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("heading", { name: "Yorumlar (0)" })).toBeVisible();

  // Cancelling the post dialog keeps the post
  await page.getByRole("button", { name: "Sil" }).click();
  const postConfirm = page.getByRole("dialog", { name: "Gönderi silinsin mi?" });
  await postConfirm.getByRole("button", { name: "Vazgeç" }).click();
  await expect(postConfirm).toBeHidden();
  await page.getByRole("button", { name: "Sil" }).click();
  await postConfirm.getByRole("button", { name: "Sil" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${ws.slug}/messages$`));
  await expect(page.getByText("Henüz mesaj yok")).toBeVisible();
});
