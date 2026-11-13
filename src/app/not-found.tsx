import type { Metadata } from "next";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { MAIN_ID } from "@/components/skip-link";

export const metadata: Metadata = { title: "Sayfa bulunamadı" };

export default function NotFound() {
  return (
    <main id={MAIN_ID} tabIndex={-1} className="outline-none mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-page-title">Sayfa bulunamadı</h1>
      <p className="text-muted-foreground">
        Aradığınız sayfa yok, taşınmış ya da bu sayfaya erişim yetkiniz bulunmuyor.
      </p>
      <Link href="/app" className={buttonVariants()}>
        Çalışma alanlarıma dön
      </Link>
    </main>
  );
}
