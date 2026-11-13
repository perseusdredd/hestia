"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";

/** Rendered inside the workspace shell, e.g. for a deleted post or folder. */
export default function WorkspaceNotFound() {
  const pathname = usePathname();
  const slug = pathname?.split("/")[2];
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-page-title">Sayfa bulunamadı</h1>
      <p className="text-muted-foreground">Bu kayıt silinmiş olabilir ya da hiç var olmamış olabilir.</p>
      <Link href={slug ? `/w/${encodeURIComponent(slug)}` : "/app"} className={buttonVariants()}>
        Çalışma alanına dön
      </Link>
    </div>
  );
}
