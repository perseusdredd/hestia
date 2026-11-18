"use client";

import { useActionState, useEffect, useState } from "react";
import { FolderPlus } from "lucide-react";
import { toast } from "sonner";

import { createFolderAction } from "@/app/w/[slug]/files/actions";
import { FieldError, FormError } from "@/components/form-error";
import { InternalToggle } from "@/components/internal-toggle";
import { ProjectSelect, type ProjectOption } from "@/components/project-select";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";

function NewFolderForm({
  slug,
  parentId,
  projects,
  canSetInternal,
  onDone,
}: {
  slug: string;
  parentId: string | null;
  projects: ProjectOption[];
  canSetInternal: boolean;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    createFolderAction.bind(null, slug),
    {},
  );

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Klasör oluşturuldu.");
      onDone();
    }
  }, [state, onDone]);

  return (
    <form action={formAction} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Yeni klasör</DialogTitle>
        <DialogDescription>Dosyalarınızı ve dokümanlarınızı gruplamak için bir klasör oluşturun.</DialogDescription>
      </DialogHeader>
      <input type="hidden" name="parentId" value={parentId ?? ""} />
      <FormError message={state.ok || state.fieldErrors?.name ? undefined : state.error} />
      <div className="grid gap-1.5">
        <Label htmlFor="new-folder-name">Klasör adı</Label>
        <Input
          id="new-folder-name"
          name="name"
          required
          maxLength={120}
          autoFocus
          autoComplete="off"
          defaultValue={state.values?.name ?? ""}
          key={state.values?.name ?? ""}
          placeholder="Örn. Sözleşmeler"
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <FieldError errors={state.fieldErrors?.name} />
      </div>
      {canSetInternal ? <InternalToggle id="new-folder-internal" /> : null}
      {/* A subfolder follows its parent project, so only root folders pick one. */}
      {parentId ? null : (
        <ProjectSelect
          projects={projects}
          id="new-folder-project"
          defaultValue={state.values?.projectId ?? ""}
          errors={state.fieldErrors?.projectId}
        />
      )}
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Vazgeç</DialogClose>
        <SubmitButton pending={pending} pendingText="Oluşturuluyor">
          Oluştur
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

export function NewFolderDialog({
  slug,
  parentId,
  projects = [],
  canSetInternal = false,
}: {
  slug: string;
  parentId: string | null;
  projects?: ProjectOption[];
  canSetInternal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        <FolderPlus aria-hidden />
        Yeni klasör
      </DialogTrigger>
      <DialogContent>
        {/* Remount on every open so the form starts empty. */}
        {open ? <NewFolderForm
            slug={slug}
            parentId={parentId}
            projects={projects}
            canSetInternal={canSetInternal}
            onDone={() => setOpen(false)}
          /> : null}
      </DialogContent>
    </Dialog>
  );
}
