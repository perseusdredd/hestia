import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { PostForm } from "@/components/messages/post-form";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { requireWorkspace } from "@/lib/tenant";
import { listMentionCandidates } from "@/server/comments";

import { createPostAction } from "../actions";

export const metadata: Metadata = { title: "Yeni mesaj" };

export default async function NewPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireWorkspace(slug);
  const members = await listMentionCandidates(ctx);

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
        <PostForm action={createPostAction.bind(null, slug)} submitLabel="Yayınla" members={members} />
      </div>
    </div>
  );
}
