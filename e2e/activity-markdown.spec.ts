import { checkPage, expect, nav, registerWithWorkspace, test } from "./fixtures";

test("markdown documents and posts render safely; the activity feed lists what just happened", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const { page } = a;
  const ws = await registerWithWorkspace(a);

  // ---- A markdown document ---------------------------------------------
  await nav(page, "Dosyalar");
  await page.getByRole("link", { name: "Yeni doküman" }).first().click();
  await page.getByLabel("Başlık").fill("Markdown notları");
  const content = [
    "# Kapsam",
    "",
    "- Birinci madde",
    "- İkinci madde",
    "",
    "Ayrıntılar: [Örnek bağlantı](https://example.com/kapsam) ve [kötü](javascript:alert(1)).",
  ].join("\n");
  await page.getByLabel("İçerik").fill(content);

  // Preview renders the same markdown before saving; "Yaz" goes back to the textarea.
  await page.getByRole("button", { name: "Önizle" }).click();
  await expect(page.getByRole("heading", { name: "Kapsam" })).toBeVisible();
  await expect(page.getByLabel("İçerik")).toBeHidden();
  await checkPage(page, testInfo, "document-preview");
  await page.getByRole("button", { name: "Yaz" }).click();
  await expect(page.getByLabel("İçerik")).toHaveValue(content);

  await page.getByRole("button", { name: "Dokümanı oluştur" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Markdown notları" })).toBeVisible();
  // "# Kapsam" is demoted below the page title.
  await expect(page.getByRole("heading", { level: 3, name: "Kapsam" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: /^Birinci madde$/ })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: /^İkinci madde$/ })).toBeVisible();
  const good = page.getByRole("link", { name: "Örnek bağlantı" });
  await expect(good).toHaveAttribute("href", "https://example.com/kapsam");
  await expect(good).toHaveAttribute("rel", /noopener/);
  await expect(good).toHaveAttribute("target", "_blank");
  // An unsafe URL is not a link at all.
  await expect(page.getByRole("link", { name: "kötü" })).toHaveCount(0);
  await expect(page.getByText("kötü", { exact: true })).toBeVisible();
  await checkPage(page, testInfo, "document-markdown");

  // ---- A post with markup that must stay text ----------------------------
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await nav(page, "Mesajlar");
  await page.getByRole("link", { name: "Yeni mesaj" }).first().click();
  const postTitle = "Güvenlik denemesi";
  const script = '<script>window.__e2eXss = 1; alert("xss")</script>';
  await page.getByLabel("Başlık").fill(postTitle);
  await page.getByLabel("Mesaj").fill(`${script}\n\n<img src=x onerror="alert(2)"> **kalın** metin`);
  await page.getByRole("button", { name: "Yayınla" }).click();
  await expect(page.getByRole("heading", { level: 1, name: postTitle })).toBeVisible();
  const article = page.locator("article").first();
  await expect(article.getByText(script)).toBeVisible();
  await expect(article.locator("strong").filter({ hasText: "kalın" })).toBeVisible();
  await expect(article.locator("script")).toHaveCount(0);
  await expect(article.locator("img[src='x']")).toHaveCount(0);
  expect(await page.evaluate(() => "__e2eXss" in window)).toBe(false);
  expect(dialogs).toEqual([]);
  await checkPage(page, testInfo, "post-markup-as-text");

  // ---- Activity feed -------------------------------------------------------
  await nav(page, "Akış");
  await expect(page).toHaveURL(new RegExp(`/w/${ws.slug}/activity$`));
  await expect(page.getByRole("heading", { level: 1, name: "Hareket akışı" })).toBeVisible();
  const feed = page.getByRole("main");
  await expect(feed.getByRole("heading", { name: "Bugün" })).toBeVisible();
  await expect(feed.getByText(/bir mesaj paylaştı:/)).toBeVisible();
  await expect(feed.getByRole("link", { name: postTitle })).toBeVisible();
  await expect(feed.getByText(/bir doküman oluşturdu:/)).toBeVisible();
  await expect(feed.getByRole("link", { name: "Markdown notları" })).toBeVisible();
  await checkPage(page, testInfo, "activity");

  // The type filter narrows the feed.
  await page.getByRole("navigation", { name: "Hareket türü" }).getByRole("link", { name: "Dosyalar" }).click();
  await expect(page).toHaveURL(/\/activity\?type=files/);
  await expect(feed.getByRole("link", { name: "Markdown notları" })).toBeVisible();
  await expect(feed.getByRole("link", { name: postTitle })).toHaveCount(0);

  // A feed link opens the item.
  await feed.getByRole("link", { name: "Markdown notları" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Markdown notları" })).toBeVisible();

  // The overview shows the latest entries too.
  await nav(page, "Genel bakış");
  const recent = page.getByRole("region", { name: "Son hareketler" });
  await expect(recent.getByRole("link", { name: postTitle })).toBeVisible();
  await expect(recent.getByRole("link", { name: "Markdown notları" })).toBeVisible();
  await checkPage(page, testInfo, "overview-activity");
});
