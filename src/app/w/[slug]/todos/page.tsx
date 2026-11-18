import type { Metadata } from "next";
import Link from "next/link";
import { ListChecks } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { todayDateOnly } from "@/lib/date-only";
import { NewListButton } from "@/components/todos/list-dialogs";
import { TodoListCard } from "@/components/todos/todo-list-card";
import { buttonVariants } from "@/components/ui/button";
import { requireWorkspace } from "@/lib/tenant";
import { countComments } from "@/server/comments";
import { listProjectOptions } from "@/server/projects";
import { listTodoListOptions, listTodoLists } from "@/server/todos";
import { listMemberUsers } from "@/server/workspaces";

export const metadata: Metadata = { title: "Yapılacaklar" };

export default async function TodosPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ mine?: string | string[] }>;
}) {
  const { slug } = await params;
  const { mine } = await searchParams;
  const assignedToMe = mine === "1";
  const { ctx } = await requireWorkspace(slug);

  const [lists, listOptions, members, projects] = await Promise.all([
    listTodoLists(ctx, { assignedToMe }),
    listTodoListOptions(ctx),
    listMemberUsers(ctx),
    listProjectOptions(ctx),
  ]);
  // One grouped query for every visible item.
  const commentCounts = await countComments(
    ctx,
    "todo",
    lists.flatMap((l) => l.items.map((i) => i.id)),
  );
  const today = todayDateOnly();
  const base = `/w/${slug}/todos`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Yapılacaklar"
        description="Görev listeleri, atamalar ve bitiş tarihleri."
        actions={<NewListButton slug={slug} projects={projects} />}
      />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Görev filtresi">
        <Link
          href={base}
          aria-current={assignedToMe ? undefined : "true"}
          className={buttonVariants({ variant: assignedToMe ? "outline" : "selected", size: "sm" })}
        >
          Tümü
        </Link>
        <Link
          href={`${base}?mine=1`}
          aria-current={assignedToMe ? "true" : undefined}
          className={buttonVariants({ variant: assignedToMe ? "selected" : "outline", size: "sm" })}
        >
          Bana atananlar
        </Link>
      </div>

      {lists.length === 0 ? (
        assignedToMe ? (
          <EmptyState
            icon={ListChecks}
            title="Size atanmış görev yok"
            description="Size bir görev atandığında burada görünür."
          />
        ) : (
          <EmptyState
            icon={ListChecks}
            title="Henüz liste yok"
            description="İlk görev listenizi oluşturun, ardından görevleri ekleyip ekip üyelerine atayın."
            action={<NewListButton slug={slug} />}
          />
        )
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {lists.map((list, index) => (
            <TodoListCard
              key={list.id}
              slug={slug}
              list={list}
              listOptions={listOptions}
              canReorder={!assignedToMe}
              isFirst={index === 0}
              isLast={index === lists.length - 1}
              members={members}
              today={today}
              readOnlyAdd={assignedToMe}
              commentCounts={commentCounts}
            />
          ))}
        </div>
      )}
    </div>
  );
}
