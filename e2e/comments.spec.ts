import type { Page } from "@playwright/test";

import { type Actor, checkPage, expect, expectToast, nav, registerWithWorkspace, test, type Workspace } from "./fixtures";

/** A invites B by email; B registers from the link and joins. */
async function inviteAndJoin(a: Actor, b: Actor, ws: Workspace) {
  const pa = a.page;
  const pb = b.page;
  await nav(pa, "Ayarlar");
  await pa.getByLabel("E-posta").fill(b.email);
  await pa.getByRole("button", { name: "Davet et" }).click();
  const inviteUrl = await pa.getByLabel("Davet bağlantısı").inputValue();
  await pb.goto(new URL(inviteUrl).pathname);
  await pb.getByLabel("Ad soyad").fill(b.name);
  await pb.getByLabel("Şifre").fill(b.password);
  await pb.getByRole("button", { name: "Hesap oluştur" }).click();
  await expect(pb).toHaveURL(/\/invite\//);
  await pb.getByRole("button", { name: "Daveti kabul et" }).click();
  await expect(pb).toHaveURL(new RegExp(`/w/${ws.slug}$`));
}

/** Post a comment through the thread on the current detail page. */
async function comment(page: Page, text: string) {
  const thread = page.getByRole("region", { name: /^Yorumlar/ });
  await thread.getByLabel("Yorum ekle").fill(text);
  await thread.getByRole("button", { name: "Yorum yap" }).click();
  await expectToast(page, "Yorum eklendi.");
  await expect(thread.getByText(text)).toBeVisible();
  await expect(thread.getByLabel("Yorum ekle")).toHaveValue("");
}

test("comments on a to-do, an event and a document; a keyboard @mention notifies the member", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const b = await newActor("B");
  const pa = a.page;
  const ws = await registerWithWorkspace(a);
  await inviteAndJoin(a, b, ws);

  // ---- To-do: open its page from the list, comment with a keyboard mention
  await nav(pa, "Yapılacaklar");
  await pa.getByRole("button", { name: "Yeni liste" }).first().click();
  const newList = pa.getByRole("dialog", { name: "Yeni liste" });
  await newList.getByLabel("Liste adı").fill("Teslimler");
  await newList.getByRole("button", { name: "Oluştur" }).click();
  await expectToast(pa, "Liste oluşturuldu.");
  await pa.getByLabel("Yeni görev başlığı").fill("Logo dosyalarını hazırla");
  await pa.getByLabel("Yeni görev başlığı").press("Enter");
  await pa.getByRole("link", { name: "Logo dosyalarını hazırla" }).click();
  await expect(pa).toHaveURL(/\/todos\/[^/]+$/);
  await expect(pa.getByRole("heading", { level: 1, name: "Logo dosyalarını hazırla" })).toBeVisible();

  const thread = pa.getByRole("region", { name: /^Yorumlar/ });
  const box = thread.getByLabel("Yorum ekle");
  await box.click();
  await box.pressSequentially("Hazır olunca haber verin @E2E");
  const options = pa.getByRole("listbox", { name: "Bahsedilecek üye" });
  await expect(options.getByRole("option", { name: new RegExp(b.name) })).toBeVisible();
  await checkPage(pa, testInfo, "mention-suggestions");
  await box.press("Enter");
  await expect(options).toBeHidden();
  await expect(box).toHaveValue(new RegExp(`@\\[${b.name}\\]\\(user:[^)]+\\) $`));
  await box.pressSequentially("lütfen.");
  await thread.getByRole("button", { name: "Yorum yap" }).click();
  await expectToast(pa, "Yorum eklendi.");
  // The stored token renders as a chip with the member's name, not as a link.
  await expect(thread.getByText(`@${b.name}`)).toBeVisible();
  await expect(thread.getByRole("link", { name: `@${b.name}` })).toHaveCount(0);
  await checkPage(pa, testInfo, "todo-detail");

  // The list shows the comment count on the row.
  await nav(pa, "Yapılacaklar");
  await expect(pa.getByRole("listitem").filter({ hasText: "Logo dosyalarını hazırla" })).toContainText("1 yorum");

  // ---- Event: from the agenda dialog to its page
  await nav(pa, "Takvim");
  await pa.getByRole("button", { name: "Yeni etkinlik" }).first().click();
  const eventDialog = pa.getByRole("dialog", { name: "Yeni etkinlik" });
  await eventDialog.getByLabel("Başlık").fill("Tasarım sunumu");
  await eventDialog.getByRole("button", { name: "Ekle" }).click();
  await expectToast(pa, "Etkinlik eklendi.");
  const agenda = pa.getByRole("region", { name: "Ajanda" });
  await agenda.getByRole("button", { name: /Tasarım sunumu/ }).click();
  await pa.getByRole("dialog").getByRole("link", { name: "Ayrıntılar" }).click();
  await expect(pa).toHaveURL(/\/calendar\/[^/]+$/);
  await expect(pa.getByRole("heading", { level: 1, name: "Tasarım sunumu" })).toBeVisible();
  await comment(pa, "Sunum dosyasını bir gün önce paylaşalım.");
  await checkPage(pa, testInfo, "event-detail");
  await nav(pa, "Takvim");
  await expect(agenda.getByRole("button", { name: /Tasarım sunumu/ })).toContainText("1 yorum");

  // ---- Document
  await nav(pa, "Dosyalar");
  await pa.getByRole("link", { name: "Yeni doküman" }).click();
  await pa.getByLabel("Başlık").fill("Marka rehberi");
  await pa.getByLabel("İçerik").fill("Renkler ve yazı tipleri.");
  await pa.getByRole("button", { name: "Dokümanı oluştur" }).click();
  await expect(pa.getByRole("heading", { level: 1, name: "Marka rehberi" })).toBeVisible();
  await comment(pa, "Koyu tema renklerini de ekleyelim.");

  // ---- B sees the mention notification and follows it to the to-do
  const pb = b.page;
  await pb.goto(`/w/${ws.slug}/notifications`);
  const mention = pb.getByRole("listitem").filter({ hasText: "sizden bahsetti" });
  await expect(mention).toBeVisible();
  await expect(mention).toContainText("Logo dosyalarını hazırla");
  await checkPage(pb, testInfo, "notifications-mention");
  await mention.getByRole("button").first().click();
  await expect(pb).toHaveURL(/\/todos\/[^/]+$/);
  await expect(pb.getByRole("heading", { level: 1, name: "Logo dosyalarını hazırla" })).toBeVisible();
});
