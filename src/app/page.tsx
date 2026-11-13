import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarDays,
  CheckSquare,
  FolderOpen,
  LockKeyhole,
  MessageSquare,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react";

import { Logo } from "@/components/logo";
import { buttonVariants } from "@/components/ui/button";
import { WorkspacePreview } from "@/components/workspace-preview";
import { getOptionalUser } from "@/lib/tenant";
import { MAIN_ID } from "@/components/skip-link";

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: MessageSquare, title: "Mesaj panosu", text: "Duyurular, kararlar ve yorumlar tek akışta." },
  { icon: CheckSquare, title: "Yapılacaklar", text: "Görevleri atayın, tarih verin, ilerlemeyi görün." },
  { icon: FolderOpen, title: "Dosyalar ve dokümanlar", text: "Teslimler ve notlar klasörlerde düzenli." },
  { icon: CalendarDays, title: "Takvim", text: "Toplantılar ve teslim tarihleri bir arada." },
  { icon: MessagesSquare, title: "Sohbet", text: "Kısa sorular için ekip sohbeti." },
];

const STEPS = [
  { title: "Bir alan açın", text: "Her müşteri ya da proje için ayrı bir çalışma alanı oluşturun." },
  { title: "Müşterinizi davet edin", text: "Bağlantıyı paylaşın; davet edilen kişi yalnızca o alanı görür." },
  { title: "Birlikte ilerleyin", text: "Mesajlar, görevler ve dosyalar herkesin aynı yerden takip ettiği bir düzende kalır." },
];

export default async function Home() {
  const user = await getOptionalUser();
  if (user) redirect("/app");

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-1" aria-label="Hesap">
          <Link href="/login" className={buttonVariants({ variant: "ghost" })}>
            Giriş yap
          </Link>
          <Link href="/register" className={buttonVariants({ variant: "outline" })}>
            Kayıt ol
          </Link>
        </nav>
      </header>

      <main id={MAIN_ID} tabIndex={-1} className="outline-none mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-4 pt-10 pb-16 sm:px-6 sm:pt-20">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,27rem)]">
          <section className="max-w-2xl space-y-6">
            <p className="inline-flex items-center gap-2 text-sm font-medium text-primary-text">
              <span className="size-1.5 rounded-full bg-primary" aria-hidden />
              Serbest çalışanlar ve müşterileri için
            </p>
            <h1 className="text-4xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">
              Müşterilerinizle ortak, sakin bir çalışma alanı.
            </h1>
            <p className="max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
              Hestia her müşteriye kendi alanını verir. Mesajlar, görevler, dosyalar, takvim ve
              sohbet aynı yerde durur; e-posta zincirlerinde kaybolan bir şey kalmaz.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Link href="/register" className={buttonVariants({ size: "lg", className: "px-4" })}>
                Hesap oluştur
              </Link>
              <Link href="/login" className={buttonVariants({ size: "lg", variant: "outline", className: "px-4" })}>
                Giriş yap
              </Link>
            </div>
          </section>
          {/* Desktop only: on phones the text and the buttons stay first. */}
          <WorkspacePreview className="hidden lg:block" />
        </div>

        <section aria-labelledby="how-title" className="space-y-5">
          <h2 id="how-title" className="text-section-title">
            Nasıl çalışır
          </h2>
          <ol className="grid gap-3 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="rounded-xl border bg-card p-4 shadow-xs sm:p-5">
                <span className="flex size-7 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-text tabular-nums">
                  {i + 1}
                </span>
                <p className="mt-4 font-medium">{s.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="features-title" className="space-y-5">
          <h2 id="features-title" className="text-section-title">
            Bir çalışma alanında neler var
          </h2>
          <ul className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span>
                  <span className="block font-medium">{title}</span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">{text}</span>
                </span>
              </li>
            ))}
            <li className="flex gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground">
                <LockKeyhole className="size-4" aria-hidden />
              </span>
              <span>
                <span className="block font-medium">Ayrı alanlar</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  Müşteriler birbirinin verisini görmez; her alanın üyeleri ayrıdır.
                </span>
              </span>
            </li>
          </ul>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 text-meta sm:px-6">
          Hestia · Müşterilerinizle ortak çalışma alanı
        </div>
      </footer>
    </div>
  );
}
