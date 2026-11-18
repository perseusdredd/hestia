import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";

import { ConfirmAction } from "@/components/confirm-action";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/format";
import { hasRole } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { isServiceError } from "@/server/errors";
import { getProjectOverview } from "@/server/projects";

import { archiveProjectAction } from "../actions";
import { RenameProjectForm } from "../project-forms";

export const metadata: Metadata = { title: "Proje" };

function Section({
  title,
  count,
  href,
  hrefLabel,
  empty,
  children,
}: {
  title: string;
  count: number;
  href: string;
  hrefLabel: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid content-start gap-3 rounded-xl border bg-card p-4" aria-label={title}>
      <h2 className="flex items-center justify-between gap-2 text-sm font-semibold">
        <span>{title}</span>
        <span className="text-xs font-normal text-muted-foreground">{count}</span>
      </h2>
      {count === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : <ul className="grid gap-1.5">{children}</ul>}
      <Link href={href} className="text-sm text-primary-text underline underline-offset-2 hover:no-underline">
        {hrefLabel}
      </Link>
    </section>
  );
}

export default async function ProjectPage({ params }: { params: Promise<{ slug: string; projectSlug: string }> }) {
  const { slug, projectSlug } = await params;
  const { ctx } = await requireWorkspace(slug);
  let overview;
  try {
    overview = await getProjectOverview(ctx, decodeURIComponent(projectSlug));
  } catch (e) {
    // A malformed %-escape in the slug throws URIError — treat it as not found, not a 500.
    if (e instanceof URIError || (isServiceError(e) && e.code === "NOT_FOUND")) notFound();
    throw e;
  }
  const { project, posts, todoLists, folders, events, counts } = overview;
  const isAdmin = hasRole(ctx.role, "ADMIN");
  const base = `/w/${slug}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={project.archived ? `${project.name} (arşivlendi)` : project.name}
        description={project.description ?? undefined}
        actions={
          <>
            <Link href={`${base}/projects`} className={buttonVariants({ variant: "ghost" })}>
              <ArrowLeft aria-hidden />
              Projeler
            </Link>
            {isAdmin ? (
              <ConfirmAction
                action={archiveProjectAction.bind(null, slug)}
                fields={{ id: project.id, archived: project.archived ? "false" : "true" }}
                title={project.archived ? "Proje arşivden çıkarılsın mı?" : "Proje arşivlensin mi?"}
                description={
                  project.archived
                    ? "Proje yeniden yeni öğe kabul eder."
                    : "İçerik korunur; arşivli projeye yeni öğe eklenemez."
                }
                confirmLabel={project.archived ? "Arşivden çıkar" : "Arşivle"}
                successMessage="Proje güncellendi."
                trigger={project.archived ? "Arşivden çıkar" : "Arşivle"}
                triggerVariant="outline"
                triggerSize="default"
              />
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Mesajlar" count={counts.posts} href={`${base}/messages`} hrefLabel="Tüm mesajlar" empty="Bu projede mesaj yok.">
          {posts.map((p) => (
            <li key={p.id} className="text-sm break-words">
              <Link href={`${base}/messages/${p.id}`} className="hover:underline">
                {p.title}
              </Link>
              {p.isDraft ? <span className="text-muted-foreground"> (taslak)</span> : null}
            </li>
          ))}
        </Section>
        <Section title="Yapılacaklar" count={counts.todoLists} href={`${base}/todos`} hrefLabel="Tüm yapılacaklar" empty="Bu projede liste yok.">
          {todoLists.map((l) => (
            <li key={l.id} className="flex items-baseline justify-between gap-2 text-sm">
              <span className="break-words">{l.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {l.done}/{l.total}
              </span>
            </li>
          ))}
        </Section>
        <Section title="Dosyalar" count={counts.folders} href={`${base}/files`} hrefLabel="Tüm dosyalar" empty="Bu projede klasör yok.">
          {folders.map((f) => (
            <li key={f.id} className="text-sm break-words">
              <Link href={`${base}/files/${f.id}`} className="hover:underline">
                {f.name}
              </Link>
            </li>
          ))}
        </Section>
        <Section title="Etkinlikler" count={counts.events} href={`${base}/calendar`} hrefLabel="Takvim" empty="Bu projede etkinlik yok.">
          {events.map((ev) => (
            <li key={ev.id} className="flex items-baseline justify-between gap-2 text-sm">
              <Link href={`${base}/calendar/${ev.id}`} className="break-words hover:underline">
                {ev.title}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">
                {ev.allDay ? formatDate(ev.startsAt, "d MMM yyyy") : formatDateTime(ev.startsAt)}
              </span>
            </li>
          ))}
        </Section>
      </div>

      {isAdmin ? (
        <section className="space-y-3" aria-label="Projeyi düzenle">
          <h2 className="text-sm font-semibold">Projeyi düzenle</h2>
          <RenameProjectForm slug={slug} project={project} />
        </section>
      ) : null}
    </div>
  );
}
