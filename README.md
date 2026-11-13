# Hestia

Hestia, bir serbest çalışanın kendi müşterileriyle birlikte kullandığı, Basecamp benzeri bir proje yönetimi ve ekip çalışma aracıdır. Her müşteri ya da ekip kendi **çalışma alanında** (workspace) çalışır ve başka bir çalışma alanının verisini göremez.

Her çalışma alanında şunlar var:

- **Mesajlar**: duyurular, güncellemeler, yorumlar, sabitlenen gönderiler, "Daha fazla" ile sayfalama; gönderi ve yorumlar Markdown destekler ("Yaz / Önizle")
- **Yorumlar ve @bahsetme**: gönderilerin yanı sıra görevlere (`/w/<slug>/todos/<id>`), dokümanlara ve etkinliklere (`/w/<slug>/calendar/<id>`) de yorum yazılır. Yorumda veya gönderide `@` yazınca üye listesi açılır (ok tuşları, Enter/Tab, Escape; dokunarak da seçilir); bahsedilen üye "sizden bahsetti" bildirimi alır. Görev listesi ve takvim ajandası yorum sayısını gösterir.
- **Yapılacaklar**: listeler, görev atama, bitiş tarihi, "Bana atananlar" filtresi, görevleri ve listeleri yukarı/aşağı taşıma, görevi başka listeye taşıma; her görevin kendi sayfası. Telefonda satır işlemleri (taşı, düzenle, sil) tek bir "…" menüsünde toplanır.
- **Dosyalar**: klasörler, dosya yükleme (düğmeyle veya listeye sürükleyip bırakarak, birden çok dosya, dosya başına ilerleme), indirme, önizleme sayfası (`/w/<slug>/files/view/<id>`: resim, PDF, ses, video ve düz metin), listede küçük resimler; Markdown dokümanlar (başlık, liste, tablo, görev listesi, bağlantı)
- **Takvim**: aylık görünüm, etkinlikler (her birinin kendi sayfası), yapılacakların bitiş tarihleri
- **Genel bakış**: açık ve geciken görev, bu haftaki etkinlik ve okunmamış bildirim sayıları; son mesajlar, size atanan işler, yaklaşan etkinlikler, son dosyalar ve son hareketler
- **Sohbet**: çalışma alanı genelinde anlık sohbet (Pusher, yoksa otomatik yoklama/polling)
- **Ara**: mesajlar, yorumlar, yapılacaklar, listeler, dokümanlar, dosyalar, klasörler ve etkinlikler arasında arama (üst çubuktaki arama kutusu; `/` veya `Ctrl+K` ile odaklanır)
- **Bildirimler**: size görev atandığında, yeni mesaj veya etkinlik eklendiğinde, takip ettiğiniz bir mesaja, göreve, dokümana veya etkinliğe yorum yazıldığında, biri sizden bahsettiğinde ve (sahip/yöneticilere) yeni bir üye katıldığında; üst çubukta okunmamış sayısıyla zil, `/w/<slug>/notifications` sayfasında tam liste, "Okunmamış" filtresi ve "Tümünü okundu işaretle"
- **Etkinlik** (`/w/<slug>/activity`): kim neyi ne zaman yaptı; güne göre gruplu akış, tür ve üye filtresi, "Daha fazla yükle". Genel bakışta son 5 etkinlik ("Son etkinlikler").
- **Ayarlar**: üyeler, roller, e-posta ile bağlı davet linkleri (davet e-postayla da gönderilir; kopyalanabilir link de gösterilir); sahipler için çalışma alanını silme

Çalışma alanlarından bağımsız olarak **Hesabım** (`/account`, kullanıcı menüsünden) sayfasında ad, şifre, tema (açık/koyu/sistem) ve üyesi olunan çalışma alanları yönetilir. Tema kullanıcı menüsünden de değiştirilebilir.

**Hesap güvenliği:**

- **E-posta doğrulama**: kayıtta doğrulama e-postası gider; doğrulanana kadar üstte bir uyarı ("Tekrar gönder") görünür. Bağlantı yalnızca sayfadaki düğmeye basınca kullanılır (e-posta tarayıcılarının ön yüklemesi bağlantıyı harcamaz). Eşleşen adrese gönderilmiş daveti kabul etmek de adresi doğrular.
- **Şifremi unuttum** (`/forgot-password`): kayıtlı olsun olmasın her adres için aynı yanıt; bağlantı 1 saat geçerli ve tek kullanımlık.
- **Oturum iptali**: şifre sıfırlama tüm oturumları kapatır. Hesabım'dan şifre değiştirmek diğer tarayıcıları kapatır, mevcut tarayıcıda oturumu yeniler. İptal edilen oturum `/session-expired` üzerinden temizlenip `/login`'e yönlenir.

Yığın: Next.js 15 (App Router) + TypeScript, Postgres + Prisma 6, Auth.js v5, Tailwind CSS v4 + shadcn/ui (base-ui), Cloudflare R2, Pusher Channels, date-fns (`tr`).

## Yerel kurulum

Gerekenler: Node.js 20.12+, Docker.

```bash
docker compose up -d          # Postgres 17, 127.0.0.1:5433
cp .env.example .env          # Windows: copy .env.example .env
npx auth secret               # AUTH_SECRET üretir ve .env'e yazar
npm install                   # prisma generate otomatik çalışır
npm run db:migrate            # şemayı veritabanına uygular
npm run dev                   # http://localhost:3000
```

`/register` adresinden hesap açın; ardından ilk çalışma alanınızı oluşturun.

Yerelde dosyalar `./.storage` klasörüne yazılır (`STORAGE_DRIVER="local"`). Pusher anahtarları boşsa sohbet her 3 saniyede bir yoklama yaparak çalışır. E-postalar gönderilmez, `EmailOutbox` tablosuna yazılır; giriş yapmış kullanıcı kendine gelenleri **`/dev/outbox`** sayfasında okur (aşağıya bakın).

## E-posta

Her e-posta (doğrulama, şifre sıfırlama, davet) önce `EmailOutbox` tablosuna yazılır. Bağlantılar her zaman `AUTH_URL`'den (yoksa `VERCEL_PROJECT_PRODUCTION_URL`) üretilir, istek başlıklarından (Host / X-Forwarded-Host) asla üretilmez. Üretimde ikisi de yoksa e-posta yazılmaz, akış devam eder.

| Değişken | Açıklama |
| --- | --- |
| `MAIL_DRIVER` | `outbox` (varsayılan): yalnızca tabloya yazar, hiçbir şey gönderilmez. `smtp`: satır yazıldıktan sonra SMTP ile gönderilir; satıra `sentAt` ya da `error` işlenir |
| `SMTP_HOST`, `SMTP_PORT` | SMTP sunucusu; port varsayılanı `587` (STARTTLS), `465` doğrudan TLS |
| `SMTP_USER`, `SMTP_PASS` | SMTP kimlik bilgileri (boşsa kimliksiz bağlanır) |
| `MAIL_FROM` | Gönderen, ör. `Hestia <no-reply@alanadiniz.com>` |
| `ENABLE_DEV_OUTBOX` | `true` ise `/dev/outbox` üretim derlemesinde de açılır (yalnızca yerel smoke/e2e; herkese açık sunucuda açmayın) |

SMTP hatası kullanıcının işlemini bozmaz: hata satıra yazılır, ayarlar sayfası davet e-postasının kuyrukta, gönderildi ya da gönderilemedi olduğunu gösterir.

**`/dev/outbox`**: `NODE_ENV !== "production"` iken (veya `ENABLE_DEV_OUTBOX=true` ile) ve yalnızca giriş yapmış kullanıcıya açıktır; sadece **o kullanıcının kendi e-posta adresine** yazılmış son 50 e-postayı gösterir. Adres veritabanından okunur, istekten alınmaz. Diğer durumlarda (çıkış yapılmış, üretim) `404` döner.

## Komutlar

| Komut | Ne yapar |
| --- | --- |
| `npm run dev` | Geliştirme sunucusu (Turbopack) |
| `npm run build` / `npm start` | Üretim derlemesi / üretim sunucusu |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest (servis katmanı, yerel Postgres'e bağlanır) |
| `npm run db:migrate` | Geliştirme migration'ı (`prisma migrate dev`) |
| `npm run db:deploy` | Bekleyen migration'ları uygular (`prisma migrate deploy`) |
| `npm run vercel-build` | `prisma migrate deploy && next build` (Vercel derleme komutu) |
| `npm run smoke` | Çalışan sunucuya karşı uçtan uca test (aşağıya bakın) |
| `npm run smoke:cleanup` | Smoke testin oluşturduğu `smoke-` verilerini (çalışma alanları, kullanıcılar, doğrulama/sıfırlama belirteçleri, `EmailOutbox` satırları, dosyalar) siler |
| `npm run e2e` | Playwright tarayıcı testleri (masaüstü + Pixel 7; aşağıya bakın) |
| `npm run e2e:cleanup` | E2E testlerinin oluşturduğu `e2e-` verilerini aynı şekilde siler |

### Uçtan uca smoke test

```bash
npm run build
# PowerShell: $env:AUTH_URL="http://localhost:3210"; $env:ALLOW_LOCAL_STORAGE="true"; $env:ENABLE_DEV_OUTBOX="true"; $env:CRON_SECRET="smoke-cron-secret-0123456789"; npx next start -p 3210
AUTH_URL=http://localhost:3210 ALLOW_LOCAL_STORAGE=true ENABLE_DEV_OUTBOX=true CRON_SECRET=smoke-cron-secret-0123456789 npx next start -p 3210
npm run smoke                 # başka bir terminalde
npm run smoke:cleanup
```

Script gerçek HTTP üzerinden kayıt, giriş, çalışma alanı, gönderi, görev, etkinlik, dosya yükleme/indirme, sohbet, arama, `/account` ve bildirim akışlarını çalıştırır; ardından ikinci bir kullanıcının ilk çalışma alanına (arama ve bildirimler dahil) erişemediğini (404/403), davetle katıldıktan sonra erişebildiğini ve kendisine atanan görevin bildirimini gördüğünü doğrular. Hareket akışı (üye olmayana 404) ve hesap güvenliği de denenir: doğrulama bağlantısı, `/forgot-password`'ün kayıtlı ve kayıtsız adrese aynı yanıtı vermesi, `EmailOutbox`'tan okunan (`scripts/smoke-outbox.ts`) sıfırlama bağlantısıyla şifre değiştirme, eski oturum çerezinin iptali, yeni şifreyle giriş, bağlantının ikinci kez kullanılamaması ve `/dev/outbox`'ın başka kullanıcının e-postasını hiç göstermemesi. `ENABLE_DEV_OUTBOX` olmadan `/dev/outbox` kontrolleri atlanır (`SKIP`). Script, sunucuyla aynı `DATABASE_URL`'i (`.env`) kullanmalıdır.

Ayrıca: sayfada nonce'lu CSP ve diğer güvenlik başlıkları (nonce her istekte değişir), API yanıtında `no-referrer` ve sayfa CSP'sinin olmaması, `/api/health` → 200, `/api/cron/cleanup` gizli anahtar olmadan → 401 (sunucu bu yüzden `CRON_SECRET` ile başlatılır), `image/png` diye yüklenen HTML dosyasının önizlemede 415 ile reddedilmesi, gerçek PNG'nin `sandbox` CSP'si ve `nosniff` ile satır içi sunulması, görev/etkinlik/doküman yorumları ve bunların sayfalarının (ve yorum action'ının) üye olmayana 404/ret vermesi.

### Tarayıcı testleri (Playwright)

```bash
npx playwright install chromium   # ilk kez
npm run e2e                       # derler, next start -p 3230 başlatır, dört projeyi çalıştırır
npm run e2e:cleanup
```

Testler kullanıcı gibi davranır (etiketler, roller, düğmeler): kayıt ve çalışma alanı oluşturma, mesajlar, yapılacaklar, takvim, dosyalar ve dokümanlar, iki tarayıcı arasında sohbet, davet/rol/üye çıkarma, bildirimler, arama, hesap ve tema, çıkış ve üye olmayan kullanıcı için 404; ayrıca doğrulama uyarısı ve `/dev/outbox`'tan açılan doğrulama bağlantısı, arayüzden şifre sıfırlama, e-postayla gelen davet bağlantısı, bir tarayıcıda şifre değişince diğerinin oturumunun kapanması, etkinlik akışı ve Markdown (başlık, liste, bağlantı; `<script>` metin olarak görünür). Yorumlar (görev, etkinlik, doküman), klavyeyle @bahsetme ve bahsedilen üyenin bildirimi, metin ve resim önizlemesi ve sürükle-bırak ile çoklu yükleme de denenir. Projeler: `desktop` ve `phone` (Pixel 7) tüm testleri açık temada çalıştırır; `desktop-dark` ve `phone-dark` yalnızca `e2e/themes.spec.ts`'i koyu temada çalıştırır: her ana sayfa açılır, taşma ve dokunma hedefi kontrol edilir, ekran görüntüsü alınır, CSP başlığında nonce olduğu ve hiçbir "Refused to …" / `securitypolicyviolation` olmadığı doğrulanır. Sunucu `ENABLE_DEV_OUTBOX=true` ve bir test `CRON_SECRET`'ı ile başlatılır. Tarayıcı konsolunda hata, sayfa hatası veya hydration uyarısı, telefonda yatay taşma ve 40 px altındaki dokunma hedefleri testi başarısız kılar. Her ana sayfanın ekran görüntüsü `e2e/screenshots/` altına yazılır (git dışı). `E2E_REUSE=1` zaten 3230'da çalışan sunucuyu kullanır.

## Çok kiracılı model (tenancy)

1. Kiracıya ait her tabloda `workspaceId` vardır; erişim `Membership` (OWNER / ADMIN / MEMBER) ile verilir.
2. `/w/[slug]/...` altındaki her sayfa, server action ve route handler `requireWorkspace(slug)` ile oturumu ve üyeliği kendisi kontrol eder; üye olmayana `404` döner (çalışma alanının varlığı bile açığa çıkmaz).
3. Veri erişimi `src/server/<modül>.ts` servislerindedir; her fonksiyon önce `ctx` (userId, workspaceId, role) alır ve her sorguyu `ctx.workspaceId` ile sınırlar.
4. İstemciden gelen `workspaceId`, yazar veya rol bilgisine asla güvenilmez; alt kayıt oluşturulmadan önce üst kaydın ve atanan kişinin aynı çalışma alanına ait olduğu doğrulanır.
5. Herkes içerik oluşturabilir; düzenleme/silme yazara veya ADMIN/OWNER'a aittir. Dosya indirme ve Pusher kanal yetkisi de veritabanındaki üyeliğe göre verilir.
6. Bildirimler (`src/server/notifications.ts`) yalnızca o anda çalışma alanının üyesi olan alıcılar için, işlemi yapan kişi hariç oluşturulur; bağlantı yolu çalışma alanına göreli ve sıkı bir kalıpla doğrulanır. Her kullanıcı yalnızca kendi bildirimlerini görür ve işaretler. Bildirim oluşturma ana kayıttan sonra çalışır; hata olursa günlüğe yazılır ve kullanıcının işlemi başarısız olmaz. Üyelikten çıkarılan kişinin o alandaki bildirimleri silinir.

## Güvenlik başlıkları

`src/middleware.ts` her istekte `src/lib/security-headers.ts` başlıklarını ekler:

- **Sayfalar**: istek başına üretilen nonce'lu `Content-Security-Policy` (`script-src 'self' 'nonce-…' 'strict-dynamic'`; geliştirmede ayrıca `'unsafe-eval'` ve `ws:`). Next nonce'u istek başlığındaki politikadan okur ve kendi script'lerine ekler; kök layout aynı nonce'u `next-themes`'e verir. Bu yüzden her sayfa dinamik olarak işlenir. `style-src` bilinçli olarak `'unsafe-inline'` içerir (base-ui `style` öznitelikleri, sonner ve next-themes'in nonce'suz `<style>` etiketleri). Pusher, R2 ve Google yalnızca ayarlıysa politikaya eklenir.
- **Her yanıt**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` (belirteç içeren sayfalarda ve `/api/*`'da `no-referrer`), kapalı `Permissions-Policy`, üretimde HSTS; `X-Powered-By` gönderilmez.
- **`/api/*`**: sayfa CSP'si eklenmez; dosya uçları kendi, daha sıkı politikasını gönderir.
- **Dosya önizleme** (`GET /api/files/<id>/inline`): yalnızca izin listesindeki türler (png, jpeg, gif, webp, avif, pdf; mp3/ogg/wav/webm/flac/m4a/mp4/mov) ve yalnızca dosyanın ilk baytları bu türle eşleşirse sunulur; gönderilen tür her zaman kanonik türdür. Yanıtta `nosniff`, güvenli dosya adlı `inline`, `Cross-Origin-Resource-Policy: same-origin`, `private, max-age=300` ve `default-src 'none'; …; sandbox` CSP'si vardır. SVG, HTML ve metin asla satır içi sunulmaz; metin dosyaları (en fazla 256 KB, NUL baytı yoksa) sunucuda okunup `<pre>` içinde gösterilir. Yanıtlar: oturum yoksa 401, üye değil veya bilinmeyen kimlik 404, önizlenemeyen tür 415, aralık istekleri 206/416 (yalnızca yerel sürücüde ses/video), R2'de 302.
- **R2 ile**: önizleme, kanonik tür ve `inline` ile 60 saniyelik imzalı bir GET'e yönlendirir. R2 yanıtları bizim CSP ve CORP başlıklarımızı taşıyamaz; bu yüzden R2'ye yalnızca resim/ses/video/PDF yönlendirilir, metin sunucudan okunur.
- **`GET /api/health`**: oturumsuz; `{status, db}` ve 200 (veritabanı 2 sn içinde yanıt verdi) veya 503.
- **`GET /api/cron/cleanup`**: `Authorization: Bearer $CRON_SECRET` ister (yanlışsa 401, `CRON_SECRET` yoksa 503); kullanılmış/süresi dolmuş belirteçleri, eski davetleri, 30 günden eski `EmailOutbox` satırlarını ve 90 günden eski okunmuş bildirimleri siler.

Sunucu başlarken (`src/instrumentation.ts`) ortam değişkenleri `src/lib/env.ts` ile doğrulanır; eksik veya hatalı bir değişken sunucunun açılmasını engeller ve mesaj değişkenin adını söyler.

## Yayına alma (Vercel + Neon)

### Kontrol listesi

- [ ] Neon: `DATABASE_URL` **pooled** (`-pooler`) + `?sslmode=require&pgbouncer=true&connection_limit=5&pool_timeout=15&connect_timeout=15`; `DIRECT_URL` doğrudan bağlantı (zorunlu).
- [ ] `AUTH_SECRET` (en az 32 karakter) ve `AUTH_URL` (`https://…`).
- [ ] `STORAGE_DRIVER=r2` ve dört `R2_*` değişkeninin hepsi; bucket'ta CORS kuralı (aşağıda).
- [ ] Pusher grubu ya tamamen dolu ya tamamen boş; SMTP grubu (`MAIL_DRIVER=smtp`, `SMTP_HOST`, `MAIL_FROM`, gerekirse `SMTP_USER`+`SMTP_PASS`) aynı şekilde.
- [ ] Google girişi açıksa redirect URI: `https://alanadiniz.com/api/auth/callback/google`.
- [ ] `CRON_SECRET` Vercel'de tanımlı (en az 16 karakter; `openssl rand -base64 32`). `vercel.json` temizliği her gün 03:00 UTC'de çalıştırır; anahtar yoksa uç 503 döner ve hiçbir şey temizlenmez.
- [ ] Bir uptime izleyicisi `GET /api/health`'i yoklasın (200 sağlıklı, 503 veritabanı yanıt vermiyor).
- [ ] `ENABLE_DEV_OUTBOX` Vercel'de **asla** tanımlanmasın (doğrulama bunu reddeder).

### 1. Veritabanı (Neon)

Neon'da bir proje açın ve iki bağlantı dizesini alın:

- `DATABASE_URL`: **pooled** bağlantı (host adında `-pooler` geçer), sonuna `?sslmode=require&pgbouncer=true&connection_limit=5&pool_timeout=15&connect_timeout=15` ekleyin. Uygulama bunu kullanır.
- `DIRECT_URL`: **doğrudan** bağlantı (`-pooler` olmadan), `?sslmode=require`. Migration'lar bunu kullanır.

### 2. Vercel projesi

- Repo'yu Vercel'e bağlayın (Framework: Next.js).
- **Build Command**: `npm run vercel-build` (yani `prisma generate && prisma migrate deploy && next build --turbopack`; `vercel.json` bunu zaten ayarlar).
- Ortam değişkenlerini Production (ve gerekirse Preview) için girin:

| Değişken | Değer |
| --- | --- |
| `DATABASE_URL`, `DIRECT_URL` | Neon (yukarıda) |
| `AUTH_SECRET` | `npx auth secret` ile üretilen rastgele değer |
| `AUTH_URL` | `https://alanadiniz.com` (zorunlu: e-postadaki bağlantılar buradan üretilir) |
| `AUTH_TRUST_HOST` | `true` |
| `STORAGE_DRIVER` | `r2` (Vercel'de dosya sistemi kalıcı değildir; `local` üretimde çalışmaz) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 |
| `PUSHER_APP_ID`, `PUSHER_SECRET`, `NEXT_PUBLIC_PUSHER_KEY`, `NEXT_PUBLIC_PUSHER_CLUSTER` | Pusher (isteğe bağlı) |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Google OAuth (isteğe bağlı) |
| `UPLOAD_TOKEN_SECRET` | İsteğe bağlı; boşsa `AUTH_SECRET` kullanılır |
| `MAIL_DRIVER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | E-posta (yukarıdaki "E-posta" bölümü); `MAIL_DRIVER=smtp` olmadan e-postalar yalnızca tabloya yazılır |
| `CRON_SECRET` | Günlük temizlik (`/api/cron/cleanup`) için en az 16 karakter |

`NEXT_PUBLIC_*` değişkenleri derleme sırasında koda gömülür: değiştirirseniz yeniden deploy edin.

### 3. Cloudflare R2

1. R2'de bir bucket oluşturun. Bucket **özel (private)** kalmalı; public erişim açmayın.
2. "Manage R2 API Tokens" ile yalnızca bu bucket için **Object Read & Write** yetkili bir token oluşturun; Access Key ID ve Secret'ı `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` olarak girin. `R2_ACCOUNT_ID` 32 karakterlik hesap kimliğinizdir.
3. Tarayıcı dosyayı doğrudan R2'ye yüklediği için bucket'a CORS kuralı ekleyin:

```json
[
  {
    "AllowedOrigins": ["https://alanadiniz.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "If-None-Match"],
    "MaxAgeSeconds": 3600
  }
]
```

4. Bilinen eksik: başlatılıp tamamlanmayan yüklemeler (ve silinmiş bir dosyanın süresi dolmamış yükleme linkiyle tekrar yüklenen ama tamamlanmayan baytlar) bucket'ta veritabanında kaydı olmayan nesneler bırakabilir. Henüz otomatik temizlik işi yok. Bucket geneline yaş bazlı bir Lifecycle kuralı **koymayın**; gerçek dosyaları da siler.

İndirmeler ve önizlemeler uygulama üzerinden üyelik kontrolüyle yapılır ve 60 saniyelik imzalı bir R2 linkine yönlendirilir. Önizlemede resim, ses ve video `<img>`/`<audio>`/`<video>` ile, PDF bir iframe'de açılır; bunlar CORS istemez, bu yüzden yukarıdaki kuralda `GET` gerekmez. R2 hostları CSP'ye yalnızca `STORAGE_DRIVER=r2` ve geçerli `R2_ACCOUNT_ID`/`R2_BUCKET` ile eklenir.

### 4. Pusher (gerçek zamanlı sohbet, isteğe bağlı)

1. pusher.com'da bir **Channels** uygulaması açın (ücretsiz katman yeterli), kümeyi (ör. `eu`) seçin.
2. App ID, Key, Secret ve Cluster değerlerini yukarıdaki değişkenlere girin.
3. App Settings'te **Enable client events** kapalı kalsın. Kanal yetkisi `/api/pusher/auth` üzerinden, veritabanındaki üyeliğe göre verilir (`private-workspace-<id>`).

Pusher ayarlanmazsa sohbet yoklama ile çalışmaya devam eder.

### 5. Google ile giriş (isteğe bağlı)

Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application):

- Authorized JavaScript origins: `https://alanadiniz.com`
- Authorized redirect URI: `https://alanadiniz.com/api/auth/callback/google`
- Yerel geliştirme için ayrıca: `http://localhost:3000/api/auth/callback/google`

Client ID ve Secret'ı `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` olarak girin. İkisi de boşsa Google düğmesi gizlenir. Aynı e-postayla şifreli hesabı olan bir kullanıcının Google hesabı otomatik bağlanmaz (hesap ele geçirme riskine karşı bilinçli bir tercih).

## Bilinen sınırlamalar

- **Kayıt, e-postanın kayıtlı olup olmadığını belli eder.** `/register` kayıtlı bir adrese alan hatası döner (şifremi unuttum ise belli etmez). IP başına hız sınırı bunu yavaşlatır ama kapatmaz. Doğrulanmamış hesaplar da uygulamayı tam olarak kullanabilir; doğrulama yalnızca uyarıdır.
- **Hız sınırları bellekte tutulur** (`src/server/rate-limit.ts`; giriş, kayıt, şifremi unuttum, doğrulama e-postasını tekrar gönderme): tek sunucu örneği içinde geçerlidir, örnekler arasında paylaşılmaz. Paylaşılan bir depo için `RateLimitStore` arayüzü ve asenkron `consumeRateLimit()` hazır, ama çağıranlar henüz ona taşınmadı ve Postgres/Redis deposu yok.
- **Her sayfa dinamik işlenir**: CSP nonce'u istek başına üretildiği için önceden statik olan sayfalar (giriş, açılış) artık her istekte sunucuda işlenir.
- **Önizleme**: başlığıyla uyuşmayan baytlara sahip bir resmin küçük resmi 415 alır ve tarayıcı konsoluna bir hata düşer (liste tür simgesine döner). PDF'ler için aralık isteği yok; video için kapak karesi yok; metin renklendirilmez. PDF iframe'i yalnızca geniş ekranda ve fare/izleme dörtgeniyle gösterilir, herkese "PDF'i aç" bağlantısı vardır. Yerel depolamada üyelikten çıkarılan biri, daha önce açtığı dosyalara tarayıcı önbelleğinden 5 dakikaya kadar erişebilir (`private, max-age=300`).
- **@bahsetme**: düzenleyicideki "Önizle" bahsetmeleri rozet değil düz "@Ad" olarak gösterir. Gönderi sayfası yorumları iki kez okur (`getPost` yorumları hâlâ yükler).
- **Hareket akışı ve silme**: silinen gönderi, yorum, görev listesi, görev, etkinlik, dosya, doküman ve klasörün akış satırları (ve bağlı yorum/görev satırları) silinir. Konu sütunları gelmeden önce yazılmış görev ve dosya satırları yalnızca yoluyla eşlenebildiği kadar (gönderi, doküman, klasör, `todos/<id>`, `calendar/<id>`) temizlenir; eski "todos" yollu satırlar kalır.
- **Şifremi unuttum yanıt süresi** kayıtlı ve kayıtsız adres için yalnızca kabaca eşittir (kayıtsız adreste outbox satırı yazılmaz). SMTP gönderimi yanıttan sonra çalışır.
- **E-posta kuyruğu yeniden denemez**: `MAIL_DRIVER=smtp` ile gönderim başarısız olursa hata satıra yazılır, otomatik yeniden deneme veya temizlik işi yoktur; `EmailOutbox` satırları birikir.
- Kopyalanan davet linki ile e-postadaki link aynı belirteçtir; kopyalanan linkle (eşleşen adresle) kabul etmek de adresi doğrulanmış sayar.
- **Hareket akışı** her doküman kaydını ayrı satır olarak yazar (birleştirme yok); zaten tamamlanmış bir görevi yeniden "tamamlandı" işaretlemek yeni satır yazar. Üye filtresi yalnızca mevcut üyeleri listeler.
- **Markdown**: ham HTML metin olarak gösterilir, görseller `<img>` olarak değil bağlantı olarak çıkar; yalnızca `http`, `https` ve `mailto` bağlantıları tıklanabilir. Önizleme canlı güncellenmez ("Önizle"ye basıldığı andaki metni gösterir). Mesaj listesindeki özet sunucuda 200 karakterde kesildiği için bir bağlantının ortasında bitebilir.
- Sohbette "Tekrar dene" artık aynı mesajı ikinci kez oluşturmaz (istemci kimliğiyle tekilleştirilir); silinmiş bir mesajın yeniden denenmesi yeni mesaj oluşturur.
- Yükleme anahtarları tek kullanımlıktır: silinen dosya, yükleme belirteci tekrar oynatılarak geri getirilemez. Tamamlanmamış yüklemelerden kalan sahipsiz depolama nesneleri otomatik temizlenmez. (Bu özellikten önce yüklenmiş dosyalar `20261112130000_backfill_upload_keys` migration'ıyla kayda geçirilir.)
- **Arama** düz `ILIKE` ile çalışır (tam metin indeksi yok); çok büyük çalışma alanlarında yavaşlayabilir. "I/ı" ile "İ/i" harflerini aynı kelimede karışık kullanan sorgular, ters karışımla yazılmış metni kaçırabilir. Yorum sonuçları konunun sayfasına gider; görev ve etkinlik sonuçları ise hâlâ listeye ve takvim gününe gider, kendi sayfalarına değil.
- **Bildirimler anlık değildir**: zildeki sayı sayfa geçişlerinde ve zil açıldığında sunucudan yeniden okunur (websocket yok).
- Mesaj panosunda, ilk sayfa yüklendikten sonra sabitlenen bir gönderi sonraki sayfalarda gelmez; sayfa yenilenince en üstte görünür. "Bana atananlar" filtresi açıkken yeniden sıralama kapalıdır.
