import type { Metadata } from "next";
import Link from "next/link";
import { FolderKanban } from "lucide-react";

import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { hasRole } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { listTemplates } from "@/server/project-templates";
import { listProjects, type ProjectDTO } from "@/server/projects";

import { deleteTemplateAction } from "./actions";
import { NewProjectForm } from "./project-forms";
import { NewTemplateForm, RenameTemplateForm, UseTemplateForm } from "./template-forms";

export const metadata: Metadata = { title: "Projeler" };

function ProjectRow({ slug, project }: { slug: string; project: ProjectDTO }) {
  return (
    <li>
      <Link
        href={`/w/${slug}/projects/${project.slug}`}
        className="grid gap-1 rounded-lg border bg-card p-4 shadow-xs transition-colors hover:bg-muted/40"
      >
        <span className="font-medium break-words">{project.name}</span>
        {project.description ? (
          <span className="line-clamp-2 text-sm break-words text-muted-foreground">{project.description}</span>
        ) : null}
      </Link>
    </li>
  );
}

export default async function ProjectsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const { active, archived } = await listProjects(ctx);
  const isAdmin = hasRole(ctx.role, "ADMIN");
  // Templates are ADMIN+ only; everyone else never even queries them.
  const templates = isAdmin ? await listTemplates(ctx) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projeler"
        description="Mesajları, yapılacakları, dosyaları ve etkinlikleri projelere göre gruplayın. Projesiz öğeler Genel altında kalır."
      />

      {isAdmin ? <NewProjectForm slug={slug} /> : null}

      {active.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="Henüz proje yok"
          description={isAdmin ? "Yukarıdan ilk projenizi oluşturun." : "Bir yönetici proje oluşturduğunda burada görünür."}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Projeler">
          {active.map((p) => (
            <ProjectRow key={p.id} slug={slug} project={p} />
          ))}
        </ul>
      )}

      {archived.length > 0 ? (
        <section className="space-y-3" aria-labelledby="archived-projects">
          <h2 id="archived-projects" className="text-sm font-semibold text-muted-foreground">
            Arşivlenmiş projeler
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {archived.map((p) => (
              <ProjectRow key={p.id} slug={slug} project={p} />
            ))}
          </ul>
        </section>
      ) : null}

      {isAdmin ? (
        <section className="space-y-3" aria-labelledby="project-templates">
          <h2 id="project-templates" className="text-sm font-semibold text-muted-foreground">
            Şablonlar
          </h2>
          <p className="text-sm text-muted-foreground">
            Şablonlar yapılacak listelerini, klasör yapısını ve başlangıç mesajı başlıklarını saklar; kişi, tarih ve dosya
            içeriği kopyalanmaz. Bir projeyi açıp &quot;Şablon olarak kaydet&quot; ile de şablon oluşturabilirsiniz.
          </p>
          <NewTemplateForm slug={slug} />
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">Henüz şablon yok.</p>
          ) : (
            <ul className="grid gap-3 lg:grid-cols-2" aria-label="Şablonlar">
              {templates.map((t) => (
                <li key={t.id} className="grid gap-3 rounded-lg border bg-card p-4 shadow-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="grid gap-1">
                      <span className="font-medium break-words">{t.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {t.counts.todoLists} liste, {t.counts.todoItems} yapılacak, {t.counts.folders} klasör,{" "}
                        {t.counts.posts} taslak mesaj
                      </span>
                    </div>
                    <ConfirmAction
                      action={deleteTemplateAction.bind(null, slug)}
                      fields={{ id: t.id }}
                      title="Şablon silinsin mi?"
                      description="Bu şablondan daha önce oluşturulan projeler etkilenmez."
                      confirmLabel="Sil"
                      successMessage="Şablon silindi."
                      trigger="Sil"
                      triggerVariant="outline"
                    />
                  </div>
                  <UseTemplateForm slug={slug} template={t} />
                  <RenameTemplateForm slug={slug} template={t} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
