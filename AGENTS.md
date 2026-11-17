# Hestia — yapay zekâ ajanları ve geliştiriciler için kurallar

Hestia, Basecamp benzeri çok kiracılı (workspace) bir proje yönetim aracıdır. README.md ürünü ve kurulumu anlatır; bu dosya nasıl çalışılacağını anlatır.

## Yığın
Next.js 15 (App Router) + TypeScript, Postgres + Prisma 6, Auth.js v5, Tailwind v4 + shadcn/ui (base-ui), Vitest, Playwright. Arayüz dili **Türkçe**.

## Komutlar
- `docker compose up -d` — yerel Postgres (127.0.0.1:5433). `cp .env.example .env`, `npx auth secret`, `npm install`, `npm run db:migrate`, `npm run dev`.
- Değişiklikten sonra **hepsi geçmeli**: `npm run typecheck`, `npm run lint`, `npm test`. Arayüzü etkileyen işlerde `npm run e2e` (önce `npx playwright install chromium`).
- Gerçek `.env` dosyalarını, sunucu bilgilerini ve gizli anahtarları asla commit etme, sohbete yapıştırma.

## Değişmez kurallar (güvenlik)
1. **Çok kiracılılık**: kiracıya ait her tabloda `workspaceId` vardır. Veri erişimi yalnızca `src/server/<modül>.ts` servislerindedir; her fonksiyon `ctx` (userId, workspaceId, role) alır ve **her sorguyu `ctx.workspaceId` ile sınırlar**. İstemciden gelen `workspaceId`, yazar ya da rol bilgisine güvenme.
2. `/w/[slug]/...` altındaki her sayfa, server action ve route handler `requireWorkspace(slug)` ile oturumu ve üyeliği kendisi kontrol eder; üye olmayana 404 döner.
3. Güvenlik başlıkları ve nonce'lu CSP `src/middleware.ts` ve `src/lib/security-headers.ts` içindedir. Gevşetme; yeni dış kaynak gerekiyorsa orada açıkça ekle.
4. Tek tıkla giriş (`src/server/sso.ts`, `src/app/sso/route.ts`) imzalı, kısa ömürlü, tek kullanımlık token ister; doğrulamayı zayıflatma.
5. Veritabanı: şema değişikliği yalnızca `prisma/migrations` altında migration ile yapılır. **Uygulama her başladığında migration'lar canlıda otomatik çalışır** (`prisma migrate deploy`). Tablo/sütun silen ya da veri kaybettiren migration yazma; gerekiyorsa önce PR açıklamasında belirt.

## Tasarım
Renkler `src/app/globals.css` içindeki token'lardadır (Perseus asistan uygulamasıyla uyumlu iOS tarzı palet: gri zemin, beyaz kartlar, mavi vurgu, koyu temada siyah). Sabit renk yazma, token kullan. Her metin çifti ≥ 4.5:1, her kontrol sınırı ≥ 3:1 kontrast sağlamalı; telefonda dokunma hedefleri ≥ 40 px.

## İş akışı
- `main` dalına doğrudan yazma. Dal aç (`ozellik/kisa-ad`), Pull Request aç, CI (typecheck, lint, test, build, e2e) yeşil olsun, bir insan incelesin, sonra birleştir.
- `main`'e birleşince CI geçerse sunucuya **otomatik yayınlanır** (`.github/workflows/deploy.yml`). Yani birleşen her şey canlıya çıkar.
- Küçük, odaklı PR'lar aç. Davranış değiştiriyorsan test ekle.
- Commit mesajları kısa ve açıklayıcı olsun.
