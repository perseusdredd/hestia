import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Inbox } from "lucide-react";

import { Logo } from "@/components/logo";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { checkSession, sessionExpiredUrl } from "@/lib/tenant";
import { DEV_OUTBOX_TAKE, devOutboxEnabled, listOwnOutbox, type OutboxMailDTO } from "@/server/mail";
import { MAIN_ID } from "@/components/skip-link";

export const metadata: Metadata = {
  title: "Giden e-postalar (geliştirici)",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// Env flag and session are read per request.
export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  invite: "Davet",
  "verify-email": "E-posta doğrulama",
  "password-reset": "Şifre sıfırlama",
};

/**
 * http(s) links in a mail body. Unlike LinkifiedText (user content) this also
 * accepts dotless hosts such as localhost, since mailed links point at
 * AUTH_URL, which is often http://localhost:<port> in development.
 */
function mailLinks(text: string): string[] {
  const out: string[] = [];
  for (const [raw] of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    try {
      const url = new URL(raw);
      if ((url.protocol === "http:" || url.protocol === "https:") && !out.includes(url.href)) out.push(url.href);
    } catch {
      // not a URL
    }
  }
  return out;
}

function Status({ mail }: { mail: OutboxMailDTO }) {
  if (mail.error) return <Badge variant="destructive">Gönderilemedi</Badge>;
  if (mail.sentAt) return <Badge variant="secondary">Gönderildi</Badge>;
  return <Badge variant="outline">Kuyrukta</Badge>;
}

/**
 * Developer mailbox: reads the EmailOutbox rows addressed to the signed-in
 * user's own email, so flows can be tried locally without SMTP. 404 when the
 * feature is off (production without ENABLE_DEV_OUTBOX=true) or signed out.
 */
export default async function DevOutboxPage() {
  if (!devOutboxEnabled()) notFound();
  const check = await checkSession();
  if (check.status === "revoked") redirect(sessionExpiredUrl("/dev/outbox"));
  if (check.status !== "ok") notFound();
  const user = check.user;
  const mails = await listOwnOutbox(user.id);

  return (
    <div className="min-h-dvh bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center px-4 sm:px-6">
          <Link href="/app" aria-label="Çalışma alanlarım">
            <Logo />
          </Link>
        </div>
      </header>
      <main id={MAIN_ID} tabIndex={-1} className="outline-none mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
        <PageHeader
          title="Giden e-postalar"
          description={
            <>
              Geliştirici sayfası: yalnızca <span className="font-medium break-all">{user.email}</span>{" "}
              adresine yazılan son {DEV_OUTBOX_TAKE} e-posta listelenir, en yenisi üstte.
            </>
          }
        />
        {mails.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="Henüz e-posta yok"
            description="Kayıt, davet veya şifre sıfırlama e-postaları burada görünür."
          />
        ) : (
          <ul className="space-y-4">
            {mails.map((m) => (
              <li key={m.id}>
                <article
                  aria-label={m.subject}
                  className="min-w-0 space-y-3 rounded-xl border bg-card p-4"
                  data-kind={m.kind}
                >
                  <header className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <h2 className="font-medium break-words">{m.subject}</h2>
                      <p className="text-xs text-muted-foreground">
                        {KIND_LABELS[m.kind] ?? m.kind} · {formatDateTime(m.createdAt)}
                      </p>
                    </div>
                    <Status mail={m} />
                  </header>
                  <p className="rounded-lg bg-muted/50 p-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
                    {m.text}
                  </p>
                  {mailLinks(m.text).length > 0 ? (
                    <ul aria-label="Bağlantılar" className="grid gap-1 text-sm">
                      {mailLinks(m.text).map((href) => (
                        <li key={href} className="min-w-0">
                          <a
                            href={href}
                            rel="noreferrer"
                            className="break-all text-primary-text underline underline-offset-2 hover:no-underline pointer-coarse:inline-block pointer-coarse:py-2.5"
                          >
                            {href}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {m.error ? (
                    <p className="text-sm break-words text-destructive">Hata: {m.error}</p>
                  ) : null}
                </article>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
