import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { PostForm } from "@/components/messages/post-form";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { isGuest } from "@/lib/roles";
import { requireWorkspace } from "@/lib/tenant";
import { listMentionCandidates } from "@/server/comments";
import { listCategories } from "@/server/message-categories";
import { listProjectOptions } from "@/server/projects";

import { createPostAction } from "../actions";

export const metadata: Metadata = { title: "Yeni mesaj" };

export default async function NewPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const [members, categories, projects] = await Promise.all([
    listMentionCandidates(ctx),
    listCategories(ctx),
    listProjectOptions(ctx),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Yeni mesaj"
        actions={
          <Link href={`/w/${slug}/messages`} className={buttonVariants({ variant: "ghost" })}>
            <ArrowLeft aria-hidden />
            Mesajlar
          </Link>
        }
      />
      <div className="max-w-2xl">
        <PostForm action={createPostAction.bind(null, slug)} submitLabel="Yayınla" members={members} categories={categories} projects={projects} canSetInternal={!isGuest(ctx.role)} />
      </div>
    </div>
  );
}
