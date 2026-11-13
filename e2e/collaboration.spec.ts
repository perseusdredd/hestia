import { checkPage, expect, expectToast, nav, register, registerWithWorkspace, test, todoAction } from "./fixtures";

test("invite, roles, chat between two members, notifications, search, removal", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const b = await newActor("B");
  const pa = a.page;
  const pb = b.page;
  await a.context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const ws = await registerWithWorkspace(a);

  // A posts something we can search for later
  await nav(pa, "Mesajlar");
  await pa.getByRole("link", { name: "Yeni mesaj" }).first().click();
  await pa.getByLabel("Başlık").fill("Lansman planı");
  await pa.getByLabel("Mesaj").fill("Kampanya takvimi ekte. Anahtar kelime: zeplin");
  await pa.getByRole("button", { name: "Yayınla" }).click();
  await expect(pa.getByRole("heading", { level: 1, name: "Lansman planı" })).toBeVisible();

  // ---- Invite B --------------------------------------------------------
  await nav(pa, "Ayarlar");
  await expect(pa.getByRole("heading", { level: 1, name: "Ayarlar" })).toBeVisible();
  await expect(pa.getByText("Bekleyen davet yok")).toBeVisible();
  await pa.getByLabel("E-posta").fill(b.email);
  await pa.getByRole("button", { name: "Davet et" }).click();
  const link = pa.getByLabel("Davet bağlantısı");
  await expect(link).toBeVisible();
  const inviteUrl = await link.inputValue();
  expect(inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);
  await pa.getByRole("button", { name: "Bağlantıyı kopyala" }).click();
  await expectToast(pa, "Panoya kopyalandı.");
  expect(await pa.evaluate(() => navigator.clipboard.readText())).toBe(inviteUrl);
  await expect(pa.getByText(b.email).first()).toBeVisible();
  await checkPage(pa, testInfo, "settings");

  // ---- B registers from the invite and accepts -------------------------
  await pb.goto(new URL(inviteUrl).pathname);
  await expect(pb.getByText(ws.name)).toBeVisible();
  await checkPage(pb, testInfo, "invite-signed-out");
  await pb.getByRole("link", { name: "Hesap oluştur" }).click();
  await expect(pb.getByLabel("E-posta")).toHaveValue(b.email);
  await pb.getByLabel("Ad soyad").fill(b.name);
  await pb.getByLabel("Şifre").fill(b.password);
  await pb.getByRole("button", { name: "Hesap oluştur" }).click();
  await expect(pb).toHaveURL(/\/invite\//);
  await checkPage(pb, testInfo, "invite-accept");
  await pb.getByRole("button", { name: "Daveti kabul et" }).click();
  await expect(pb).toHaveURL(new RegExp(`/w/${ws.slug}$`));
  await expect(pb.getByRole("heading", { level: 1, name: ws.name })).toBeVisible();

  // ---- A sees B, changes the role --------------------------------------
  await pa.reload();
  const bRow = pa.getByRole("listitem").filter({ hasText: b.email }).filter({ has: pa.getByRole("combobox") });
  await expect(bRow).toBeVisible();
  await bRow.getByRole("combobox", { name: `${b.name} rolü` }).selectOption({ label: "Yönetici" });
  await expectToast(pa, "Rol güncellendi.");
  await pa.reload();
  await expect(pa.getByRole("combobox", { name: `${b.name} rolü` })).toHaveValue("ADMIN");
  await expect(pa.getByText("Bekleyen davet yok")).toBeVisible();

  // A got a "joined" notification
  await nav(pa, "Genel bakış");
  await pa.getByRole("button", { name: /^Bildirimler, 1 okunmamış/ }).click();
  await expect(pa.getByRole("menuitem", { name: new RegExp(`${b.name} çalışma alanına katıldı`) })).toBeVisible();
  await pa.keyboard.press("Escape");

  // ---- Chat: polling transport, two contexts ---------------------------
  await nav(pa, "Sohbet");
  await nav(pb, "Sohbet");
  await expect(pa.getByText("Henüz mesaj yok")).toBeVisible();
  await checkPage(pa, testInfo, "chat-empty");
  const composerA = pa.getByRole("textbox", { name: "Mesaj" });
  await composerA.fill("Merhaba ekip! Toplantı 14:00'te.");
  await composerA.press("Enter");
  await expect(composerA).toHaveValue("");
  const feedA = pa.getByRole("list", { name: "Mesajlar" });
  await expect(feedA.getByText("Merhaba ekip! Toplantı 14:00'te.")).toBeVisible();
  await expect(feedA.getByText("Gönderiliyor…")).toBeHidden();

  // B sees it arrive without reloading
  const feedB = pb.getByRole("list", { name: "Mesajlar" });
  await expect(feedB.getByText("Merhaba ekip! Toplantı 14:00'te.")).toBeVisible({ timeout: 20_000 });
  await pb.getByRole("textbox", { name: "Mesaj" }).fill("Tamamdır, geliyorum.");
  await pb.getByRole("button", { name: "Gönder" }).click();
  await expect(feedA.getByText("Tamamdır, geliyorum.")).toBeVisible({ timeout: 20_000 });
  await checkPage(pa, testInfo, "chat");

  // A deletes their own message
  const lineText = "Merhaba ekip! Toplantı 14:00'te.";
  const line = feedA.locator("div").filter({ has: pa.getByText(lineText, { exact: true }) }).last();
  await line.hover();
  await line.getByRole("button", { name: "Mesajı sil" }).click();
  const del = pa.getByRole("dialog", { name: "Mesaj silinsin mi?" });
  await del.getByRole("button", { name: "Sil" }).click();
  await expectToast(pa, "Mesaj silindi.");
  await expect(del).toBeHidden();
  await expect(feedA.getByText("Merhaba ekip! Toplantı 14:00'te.")).toBeHidden();
  await pa.reload();
  await expect(feedA.getByText("Tamamdır, geliyorum.")).toBeVisible();
  await expect(feedA.getByText("Merhaba ekip! Toplantı 14:00'te.")).toBeHidden();

  // ---- Notifications: A assigns a to-do to B ---------------------------
  await nav(pa, "Yapılacaklar");
  await pa.getByRole("button", { name: "Yeni liste" }).first().click();
  await pa.getByRole("dialog", { name: "Yeni liste" }).getByLabel("Liste adı").fill("Lansman");
  await pa.getByRole("dialog", { name: "Yeni liste" }).getByRole("button", { name: "Oluştur" }).click();
  await expectToast(pa, "Liste oluşturuldu.");
  await pa.getByLabel("Yeni görev başlığı").fill("Basın bültenini yaz");
  await pa.getByLabel("Yeni görev başlığı").press("Enter");
  await todoAction(pa, pa, "Basın bültenini yaz", "edit", testInfo);
  const edit = pa.getByRole("dialog", { name: "Görevi düzenle" });
  await edit.getByLabel("Atanan kişi").selectOption({ label: b.name });
  await edit.getByRole("button", { name: "Kaydet" }).click();
  await expectToast(pa, "Görev güncellendi.");

  // B: navigating refreshes the bell
  await nav(pb, "Genel bakış");
  const bell = pb.getByRole("button", { name: /^Bildirimler, 1 okunmamış/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const item = pb.getByRole("menuitem", { name: new RegExp(`${a.name} size bir görev atadı`) });
  await expect(item).toBeVisible();
  await checkPage(pb, testInfo, "notification-bell");
  await item.click();
  await expect(pb).toHaveURL(new RegExp(`/w/${ws.slug}/todos`));
  await expect(pb.getByText("Basın bültenini yaz")).toBeVisible();
  await expect(pb.getByRole("button", { name: "Bildirimler", exact: true })).toBeVisible();
  await pb.goto(`/w/${ws.slug}/notifications`);
  await expect(pb.getByText(`${a.name} size bir görev atadı`)).toBeVisible();
  await checkPage(pb, testInfo, "notifications");

  // ---- Search -----------------------------------------------------------
  const search = pa.getByRole("searchbox", { name: "Çalışma alanında ara" }).filter({ visible: true });
  await search.fill("zeplin");
  await search.press("Enter");
  await expect(pa).toHaveURL(new RegExp(`/w/${ws.slug}/search\\?q=zeplin`));
  await expect(pa.getByRole("link", { name: /Lansman planı/ })).toBeVisible();
  await checkPage(pa, testInfo, "search");
  await pa.getByRole("link", { name: /Lansman planı/ }).click();
  await expect(pa.getByRole("heading", { level: 1, name: "Lansman planı" })).toBeVisible();

  // ---- Remove B -----------------------------------------------------------
  await nav(pa, "Ayarlar");
  await pa.getByRole("button", { name: `${b.name} kişisini çıkar` }).click();
  const remove = pa.getByRole("dialog", { name: `${b.name} çıkarılsın mı?` });
  await remove.getByRole("button", { name: "Üyeyi çıkar" }).click();
  await expectToast(pa, "Üye çıkarıldı.");
  await expect(pa.getByText(b.email)).toBeHidden();

  // B lost access: the workspace is a Turkish 404 now
  b.allow.push(/Failed to load resource: the server responded with a status of 404/);
  const res = await pb.goto(`/w/${ws.slug}`);
  expect(res?.status()).toBe(404);
  await expect(pb.getByRole("heading", { name: "Sayfa bulunamadı" })).toBeVisible();
});

test("bell: a slow, older refresh never overwrites a newer one", async ({ newActor }) => {
  const a = await newActor("A");
  const pa = a.page;
  await registerWithWorkspace(a);

  // Hold the first bell refresh (from navigation) and answer it late with
  // stale data; let later refreshes through to the real server.
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((r) => (releaseFirst = r));
  let firstDone!: () => void;
  const firstAnswered = new Promise<void>((r) => (firstDone = r));
  let seen = 0;
  await pa.route(/\/api\/notifications\//, async (route) => {
    seen += 1;
    if (seen > 1) return route.continue();
    await firstHeld;
    await route.fulfill({ json: { unread: 3, items: [] } });
    firstDone();
  });

  await nav(pa, "Mesajlar"); // refresh #1 (held)
  await expect(pa.getByRole("heading", { level: 1, name: "Mesajlar" })).toBeVisible();
  await expect.poll(() => seen).toBe(1);
  await pa.getByRole("button", { name: "Bildirimler", exact: true }).click(); // refresh #2 (real)
  await expect(pa.getByText("Henüz bildiriminiz yok.")).toBeVisible();
  await expect.poll(() => seen).toBe(2);
  releaseFirst();
  await firstAnswered;
  await pa.waitForTimeout(500);
  await expect(pa.getByText("3 okunmamış")).toHaveCount(0);
  await pa.keyboard.press("Escape");
  await expect(pa.getByRole("button", { name: "Bildirimler", exact: true })).toBeVisible();
  await pa.unroute(/\/api\/notifications\//);
});

test("chat: a send whose response is lost settles once the row is synced (no duplicate, no resend)", async ({
  newActor,
}) => {
  const a = await newActor("A");
  const pa = a.page;
  a.allow.push(/Failed to load resource|net::ERR_/);
  await registerWithWorkspace(a);
  await nav(pa, "Sohbet");
  await expect(pa.getByText("Henüz mesaj yok")).toBeVisible();

  // The server stores the message, but the browser never gets the answer.
  let dropped = 0;
  await pa.route(/\/w\/[^/]+\/chat$/, async (route) => {
    const req = route.request();
    if (req.method() !== "POST" || !req.headers()["next-action"] || dropped > 0) return route.continue();
    dropped += 1;
    await route.fetch();
    await route.abort("failed");
  });

  const text = "Yanıtı kaybolan mesaj";
  const composer = pa.getByRole("textbox", { name: "Mesaj" });
  await composer.fill(text);
  await composer.press("Enter");
  await expect.poll(() => dropped).toBe(1);
  const feed = pa.getByRole("list", { name: "Mesajlar" });
  // Polling (every 3 s) brings the stored row; the failed optimistic copy
  // must then go away instead of sitting next to it with "Tekrar dene".
  await pa.waitForTimeout(8000);
  await expect(feed.getByRole("button", { name: "Tekrar dene" })).toHaveCount(0);
  await expect(feed.getByText(text, { exact: true })).toHaveCount(1);
  await expect(feed.getByText("Gönderiliyor…")).toHaveCount(0);
  await pa.unroute(/\/w\/[^/]+\/chat$/);
  await pa.reload();
  await expect(feed.getByText(text, { exact: true })).toHaveCount(1);
});

test("a signed-in non-member gets the Turkish 404 for every workspace URL", async ({ newActor }, testInfo) => {
  const a = await newActor("A");
  const c = await newActor("C");
  const ws = await registerWithWorkspace(a);
  const pa = a.page;

  await nav(pa, "Mesajlar");
  await pa.getByRole("link", { name: "Yeni mesaj" }).first().click();
  await pa.getByLabel("Başlık").fill("Gizli plan");
  await pa.getByLabel("Mesaj").fill("Sadece ekip görür.");
  await pa.getByRole("button", { name: "Yayınla" }).click();
  await expect(pa.getByRole("heading", { level: 1, name: "Gizli plan" })).toBeVisible();
  const postPath = new URL(pa.url()).pathname;

  await register(c);
  c.allow.push(/Failed to load resource: the server responded with a status of 404/);
  const paths = [
    `/w/${ws.slug}`,
    `/w/${ws.slug}/messages`,
    postPath,
    `/w/${ws.slug}/todos`,
    `/w/${ws.slug}/files`,
    `/w/${ws.slug}/calendar`,
    `/w/${ws.slug}/chat`,
    `/w/${ws.slug}/settings`,
    `/w/${ws.slug}/notifications`,
    `/w/${ws.slug}/search?q=gizli`,
  ];
  for (const path of paths) {
    const res = await c.page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(c.page.getByRole("heading", { name: "Sayfa bulunamadı" }), path).toBeVisible();
    await expect(c.page.getByText("Gizli plan")).toHaveCount(0);
  }
  await checkPage(c.page, testInfo, "not-found");
  await c.page.getByRole("link", { name: "Çalışma alanlarıma dön" }).click();
  await expect(c.page).toHaveURL(/\/onboarding/);
});
