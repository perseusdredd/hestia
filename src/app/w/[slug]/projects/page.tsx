import type { Metadata } from "next";
import Link from "next/link";
import { FolderKanban } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { hasRole } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { listProjects, type ProjectDTO } from "@/server/projects";

import { NewProjectForm } from "./project-forms";

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
    </div>
  );
}
