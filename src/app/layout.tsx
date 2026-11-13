import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import { ThemeProvider } from "next-themes";

import { RouteFocus } from "@/components/route-focus";
import { SkipLink } from "@/components/skip-link";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

// Self-hosted Geist from the "geist" package (no build-time fetch from Google
// Fonts). The package's own GeistSans export hard-codes --font-geist-sans, so
// the same files are loaded here under the variable names globals.css uses.
// The variable woff2 files are not subset: they include latin-ext (ç ğ ı İ ş ö ü).
const geistSans = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
  variable: "--font-sans",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "../../node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
});

export const metadata: Metadata = {
  title: { default: "Hestia", template: "%s · Hestia" },
  description:
    "Serbest çalışanlar ve müşterileri için ortak çalışma alanı: mesajlar, görevler, dosyalar, takvim ve sohbet tek yerde.",
  applicationName: "Hestia",
};

export const viewport: Viewport = {
  // Matches --background in globals.css for each scheme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbf9f5" },
    { media: "(prefers-color-scheme: dark)", color: "#16120f" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Per-request CSP nonce from the middleware. Reading headers() also keeps
  // every page dynamically rendered, which the nonce requires (a prerendered
  // page would carry scripts without it and be blocked by 'strict-dynamic').
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="tr"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="min-h-dvh antialiased">
        <SkipLink />
        <ThemeProvider nonce={nonce} attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <RouteFocus />
          {/* Bottom: on phones a top toast covered the header and the search box. */}
          <Toaster position="bottom-right" closeButton mobileOffset={{ bottom: 136 }} />
        </ThemeProvider>
      </body>
    </html>
  );
}
