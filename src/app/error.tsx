"use client";

import { useEffect } from "react";
import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { MAIN_ID } from "@/components/skip-link";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main id={MAIN_ID} tabIndex={-1} className="outline-none mx-auto flex min-h-[60dvh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-page-title">Bir şeyler ters gitti</h1>
      <p className="text-muted-foreground">
        Beklenmeyen bir hata oluştu. Tekrar deneyebilir ya da çalışma alanlarınıza dönebilirsiniz.
        {error.digest ? <span className="mt-2 block font-mono text-xs">Hata kodu: {error.digest}</span> : null}
      </p>
      <div className="flex gap-2">
        <Button onClick={() => reset()}>Tekrar dene</Button>
        <Link href="/app" className={buttonVariants({ variant: "outline" })}>
          Çalışma alanlarım
        </Link>
      </div>
    </main>
  );
}
