import Link from "next/link";

import { Logo } from "@/components/logo";
import { MAIN_ID } from "@/components/skip-link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10 sm:justify-center sm:py-16">
      <div className="w-full max-w-sm">
        <Link
          href="/"
          className="mb-6 inline-flex h-10 items-center rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label="Hestia ana sayfa"
        >
          <Logo />
        </Link>
        <main id={MAIN_ID} tabIndex={-1} className="outline-none">
          {children}
        </main>
        <p className="mt-6 text-center text-meta">
          Müşterilerinizle ortak, sakin bir çalışma alanı.
        </p>
      </div>
    </div>
  );
}
