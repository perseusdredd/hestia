import { checkPage, expect, expectToast, isPhone, nav, registerWithWorkspace, test } from "./fixtures";

/** Today's YYYY-MM-DD in Istanbul (the app's calendar zone). */
function istanbulToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date());
}

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function monthLabel(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

test("calendar: create via dialog, see in grid and agenda, edit, delete, navigate", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const { page } = a;
  const ws = await registerWithWorkspace(a);
  const today = istanbulToday();
  const month = today.slice(0, 7);

  await nav(page, "Takvim");
  await expect(page.getByRole("heading", { level: 1, name: "Takvim" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(monthLabel(month), "i") })).toBeVisible();
  await expect(page.getByText("Bu ay için etkinlik yok")).toBeVisible();
  await checkPage(page, testInfo, "calendar-empty");

  // Create from the header button: defaults to today 09:00-10:00
  await page.getByRole("button", { name: "Yeni etkinlik" }).first().click();
  let dialog = page.getByRole("dialog", { name: "Yeni etkinlik" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Başlangıç")).toHaveValue(`${today}T09:00`);
  await expect(dialog.getByLabel("Bitiş")).toHaveValue(`${today}T10:00`);
  await dialog.getByLabel("Başlık").fill("Sprint planlama");
  await dialog.getByLabel("Konum").fill("Toplantı odası 2");
  await dialog.getByLabel("Açıklama").fill("Gündem: hedefler");
  await checkPage(page, testInfo, "calendar-dialog");
  await dialog.getByRole("button", { name: "Ekle" }).click();
  await expectToast(page, "Etkinlik eklendi.");
  await expect(dialog).toBeHidden();

  const agenda = page.getByRole("region", { name: "Ajanda" });
  const grid = page.getByRole("region", { name: "Ay görünümü" });
  await expect(agenda.getByRole("button", { name: /Sprint planlama/ })).toBeVisible();
  await expect(agenda).toContainText("09:00");
  await expect(agenda).toContainText("Toplantı odası 2");
  if (!isPhone(testInfo)) {
    // Desktop grid shows chips; phones show dots and rely on the agenda.
    await expect(grid.getByRole("button", { name: /Sprint planlama/ })).toBeVisible();
  }
  await checkPage(page, testInfo, "calendar-month");

  // Edit from the agenda
  await agenda.getByRole("button", { name: /Sprint planlama/ }).click();
  dialog = page.getByRole("dialog", { name: "Etkinliği düzenle" });
  await expect(dialog.getByLabel("Başlık")).toHaveValue("Sprint planlama");
  await dialog.getByLabel("Başlık").fill("Sprint planlama (güncel)");
  await dialog.getByLabel("Tüm gün").check();
  await expect(dialog.getByLabel("Başlangıç")).toHaveValue(today);
  await dialog.getByRole("button", { name: "Kaydet" }).click();
  await expectToast(page, "Etkinlik güncellendi.");
  await expect(dialog).toBeHidden();
  await expect(agenda.getByRole("button", { name: /Sprint planlama \(güncel\)/ })).toBeVisible();
  await expect(agenda).toContainText("Tüm gün");

  // Delete (nested confirm dialog)
  await agenda.getByRole("button", { name: /Sprint planlama \(güncel\)/ }).click();
  dialog = page.getByRole("dialog", { name: "Etkinliği düzenle" });
  await dialog.getByRole("button", { name: "Etkinliği sil" }).click();
  const confirm = page.getByRole("dialog", { name: "Etkinlik silinsin mi?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Sil" }).click();
  await expectToast(page, "Etkinlik silindi.");
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Bu ay için etkinlik yok")).toBeVisible();

  // Navigate months
  const next = shiftMonth(month, 1);
  await page.getByRole("link", { name: "Sonraki ay" }).click();
  await expect(page).toHaveURL(new RegExp(`month=${next}`));
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(monthLabel(next), "i") })).toBeVisible();

  // Create on a specific day by clicking that day's cell
  const fifteenth = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", weekday: "long", timeZone: "UTC" })
    .formatToParts(new Date(`${next}-15T12:00:00Z`));
  const dayLabel = `${fifteenth.find((p) => p.type === "day")!.value} ${fifteenth.find((p) => p.type === "month")!.value} ${fifteenth.find((p) => p.type === "weekday")!.value}`;
  await grid.getByRole("button", { name: `${dayLabel} için etkinlik ekle` }).click();
  dialog = page.getByRole("dialog", { name: "Yeni etkinlik" });
  await expect(dialog.getByLabel("Başlangıç")).toHaveValue(`${next}-15T09:00`);
  await dialog.getByLabel("Başlık").fill("Ay sonu demo");
  await dialog.getByRole("button", { name: "Ekle" }).click();
  await expectToast(page, "Etkinlik eklendi.");
  await expect(agenda.getByRole("button", { name: /Ay sonu demo/ })).toBeVisible();

  await page.getByRole("link", { name: "Önceki ay" }).click();
  await expect(page).toHaveURL(new RegExp(`month=${month}`));
  await page.getByRole("link", { name: "Önceki ay" }).click();
  await expect(page).toHaveURL(new RegExp(`month=${shiftMonth(month, -1)}`));
  await page.getByRole("link", { name: "Bugün" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${ws.slug}/calendar$`));
  await expect(page.getByRole("heading", { level: 2, name: new RegExp(monthLabel(month), "i") })).toBeVisible();
});
