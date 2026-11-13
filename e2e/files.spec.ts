import { readFile } from "node:fs/promises";

import type { Page } from "@playwright/test";

import { checkPage, expect, expectToast, nav, registerWithWorkspace, test } from "./fixtures";

async function openItemMenu(page: Page, name: string) {
  await page.getByRole("button", { name: `${name} için işlemler` }).click();
  await expect(page.getByRole("menu")).toBeVisible();
}

test("files: folder, upload, download, rename, move, documents, delete", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const { page } = a;
  const ws = await registerWithWorkspace(a);

  await nav(page, "Dosyalar");
  await expect(page.getByRole("heading", { level: 1, name: "Dosyalar" })).toBeVisible();
  await expect(page.getByText("Henüz dosya yok")).toBeVisible();
  await checkPage(page, testInfo, "files-empty");

  // Folder
  await page.getByRole("button", { name: "Yeni klasör" }).click();
  let dialog = page.getByRole("dialog", { name: "Yeni klasör" });
  await dialog.getByLabel("Klasör adı").fill("Sözleşmeler");
  await dialog.getByRole("button", { name: "Oluştur" }).click();
  await expectToast(page, "Klasör oluşturuldu.");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("link", { name: "Sözleşmeler" })).toBeVisible();

  // Upload through the real file chooser
  const content = `Merhaba Hestia! ${Date.now()}\nİkinci satır: çğıöşü`;
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Dosya yükle" }).click();
  await (await chooser).setFiles({ name: "notlar.txt", mimeType: "text/plain", buffer: Buffer.from(content) });
  await expect(page.getByRole("status").filter({ hasText: "Yükleme bitti (1/1)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "notlar.txt" })).toBeVisible();
  await checkPage(page, testInfo, "files-list");
  await page.getByRole("button", { name: "Yükleme listesini kapat" }).click();

  // The name opens the preview page: the text is shown server-side in a <pre>.
  await page.getByRole("link", { name: "notlar.txt" }).click();
  await expect(page).toHaveURL(/\/files\/view\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "notlar.txt" })).toBeVisible();
  await expect(page.getByLabel("notlar.txt içeriği")).toHaveText(content);
  await checkPage(page, testInfo, "file-preview-text");

  // Download from the preview page and compare bytes
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "İndir" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("notlar.txt");
  expect(await readFile((await file.path())!, "utf8")).toBe(content);
  await page.getByRole("link", { name: "Klasöre dön" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${ws.slug}/files$`));

  // Rename
  await openItemMenu(page, "notlar.txt");
  await page.getByRole("menuitem", { name: "Yeniden adlandır" }).click();
  dialog = page.getByRole("dialog", { name: "Yeniden adlandır" });
  await dialog.getByLabel("Ad").fill("toplantı-notları.txt");
  await dialog.getByRole("button", { name: "Kaydet" }).click();
  await expectToast(page, "Ad güncellendi.");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("link", { name: "toplantı-notları.txt" })).toBeVisible();

  // Move into the folder
  await openItemMenu(page, "toplantı-notları.txt");
  await page.getByRole("menuitem", { name: "Taşı" }).click();
  dialog = page.getByRole("dialog", { name: "Taşı" });
  await dialog.getByLabel("Hedef klasör").selectOption({ label: "Sözleşmeler" });
  await dialog.getByRole("button", { name: "Taşı" }).click();
  await expectToast(page, "Taşındı.");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("link", { name: "toplantı-notları.txt" })).toBeHidden();

  // Inside the folder
  await page.getByRole("link", { name: "Sözleşmeler" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sözleşmeler" })).toBeVisible();
  await expect(page.getByRole("link", { name: "toplantı-notları.txt" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Konum" })).toContainText("Dosyalar");

  // New document in this folder
  await page.getByRole("link", { name: "Yeni doküman" }).click();
  await page.getByLabel("Başlık").fill("Proje kapsamı");
  await page.getByLabel("İçerik").fill("Hedefler:\n- Birinci\n- İkinci");
  await checkPage(page, testInfo, "document-new");
  await page.getByRole("button", { name: "Dokümanı oluştur" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Proje kapsamı" })).toBeVisible();
  // Markdown: the "- " lines render as a real list.
  await expect(page.getByRole("listitem").filter({ hasText: /^İkinci$/ })).toBeVisible();
  await checkPage(page, testInfo, "document-view");

  // Edit it
  await page.getByRole("link", { name: "Düzenle" }).click();
  await expect(page.getByLabel("Başlık")).toHaveValue("Proje kapsamı");
  await page.getByLabel("İçerik").fill("Hedefler:\n- Birinci\n- İkinci\n- Üçüncü");
  await page.getByRole("button", { name: "Kaydet" }).click();
  await expect(page).toHaveURL(/\/files\/docs\/[^/]+$/);
  await expect(page.getByRole("listitem").filter({ hasText: /^Üçüncü$/ })).toBeVisible();

  // Back to the folder via the breadcrumb, delete the document from the row menu
  await page.getByRole("navigation", { name: "Konum" }).getByRole("link", { name: "Sözleşmeler" }).click();
  await expect(page.getByRole("link", { name: "Proje kapsamı" })).toBeVisible();
  await openItemMenu(page, "Proje kapsamı");
  await page.getByRole("menuitem", { name: "Sil" }).click();
  dialog = page.getByRole("dialog", { name: "“Proje kapsamı” silinsin mi?" });
  await dialog.getByRole("button", { name: "Sil" }).click();
  await expectToast(page, "Silindi.");
  await expect(page.getByRole("link", { name: "Proje kapsamı" })).toBeHidden();

  // Delete the folder (with the file inside) from the root
  await page.getByRole("navigation", { name: "Konum" }).getByRole("link", { name: "Dosyalar" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${ws.slug}/files$`));
  await openItemMenu(page, "Sözleşmeler");
  await page.getByRole("menuitem", { name: "Sil" }).click();
  dialog = page.getByRole("dialog", { name: "“Sözleşmeler” silinsin mi?" });
  await dialog.getByRole("button", { name: "Sil" }).click();
  await expectToast(page, "Silindi.");
  await expect(page.getByText("Henüz dosya yok")).toBeVisible();
});

/** A valid 2x2 PNG (signature + IHDR + IDAT + IEND). */
const PNG_2X2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM4EWBzIsCGAUIBACduBVHnvcpNAAAAAElFTkSuQmCC",
  "base64",
);

test("files: drag-and-drop upload of several files, image preview", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const { page } = a;
  await registerWithWorkspace(a);
  await nav(page, "Dosyalar");
  await expect(page.getByText("Henüz dosya yok")).toBeVisible();

  // Drop two files on the file list through a real DataTransfer.
  const dataTransfer = await page.evaluateHandle((png: number[]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(png)], "logo.png", { type: "image/png" }));
    dt.items.add(new File(["birinci satır\nikinci satır"], "taslak.md", { type: "text/markdown" }));
    return dt;
  }, [...PNG_2X2]);
  const zone = page.locator("[data-dropzone]").first();
  await zone.dispatchEvent("dragenter", { dataTransfer });
  await zone.dispatchEvent("dragover", { dataTransfer });
  await zone.dispatchEvent("drop", { dataTransfer });
  await expect(page.getByRole("status").filter({ hasText: "Yükleme bitti (2/2)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "logo.png" })).toBeVisible();
  await expect(page.getByRole("link", { name: "taslak.md" })).toBeVisible();
  await page.getByRole("button", { name: "Yükleme listesini kapat" }).click();

  // Image preview: the inline endpoint serves the picture with its own sandbox CSP.
  // (The list's thumbnail already cached the bytes, so the headers are read with a direct request.)
  await page.getByRole("link", { name: "logo.png" }).click();
  await expect(page).toHaveURL(/\/files\/view\/[^/]+$/);
  const img = page.getByRole("img", { name: "logo.png" });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(2);
  const src = await img.getAttribute("src");
  expect(src).toMatch(/^\/api\/files\/[^/]+\/inline$/);
  const res = await page.request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");
  expect(res.headers()["content-disposition"]).toMatch(/^inline/);
  expect(res.headers()["content-security-policy"]).toContain("sandbox");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  await checkPage(page, testInfo, "file-preview-image");
});
