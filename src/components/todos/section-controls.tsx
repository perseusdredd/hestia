"use client";

import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  createSectionAction,
  deleteSectionAction,
  moveSectionAction,
  renameSectionAction,
} from "@/app/w/[slug]/todos/actions";
import { ConfirmAction } from "@/components/confirm-action";
import { FieldError, FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActionFeedback } from "@/components/use-action-feedback";
import type { TodoSectionDTO } from "@/server/todos";

/** Header row of a to-do section, with edit controls for people who may edit the list. */
export function SectionHeader({
  slug,
  section,
  count,
  canEdit,
  isFirst,
  isLast,
}: {
  slug: string;
  section: TodoSectionDTO;
  count: number;
  canEdit: boolean;
  isFirst: boolean;
  isLast: boolean;
}) {
  function move(direction: "up" | "down") {
    startTransition(async () => {
      const res = await moveSectionAction(slug, section.id, direction);
      if (!res.ok) toast.error(res.error ?? "Bölüm taşınamadı.");
    });
  }
  return (
    <div className="flex items-center justify-between gap-2 border-t bg-muted/40 px-4 py-1.5">
      <h3 className="min-w-0 break-words text-sm font-medium">
        {section.name} <span className="text-xs font-normal text-muted-foreground tabular-nums">({count})</span>
      </h3>
      {canEdit ? (
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={isFirst}
            focusableWhenDisabled
            className="data-disabled:opacity-50"
            onClick={() => move("up")}
            aria-label={`"${section.name}" bölümünü yukarı taşı`}
          >
            <ArrowUp aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={isLast}
            focusableWhenDisabled
            className="data-disabled:opacity-50"
            onClick={() => move("down")}
            aria-label={`"${section.name}" bölümünü aşağı taşı`}
          >
            <ArrowDown aria-hidden />
          </Button>
          <RenameSectionButton slug={slug} section={section} />
          <ConfirmAction
            action={deleteSectionAction.bind(null, slug)}
            fields={{ id: section.id }}
            title="Bölüm silinsin mi?"
            description={`"${section.name}" bölümü silinir; içindeki görevler listede bölümsüz kalır.`}
            confirmLabel="Bölümü sil"
            trigger={<Trash2 aria-hidden />}
            triggerSize="icon-sm"
            triggerLabel={`"${section.name}" bölümünü sil`}
          />
        </div>
      ) : null}
    </div>
  );
}

function RenameSectionButton({ slug, section }: { slug: string; section: TodoSectionDTO }) {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setFormKey((k) => k + 1);
        setOpen(o);
      }}
    >
      <DialogTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`"${section.name}" bölümünü yeniden adlandır`} />}
      >
        <Pencil aria-hidden />
      </DialogTrigger>
      <DialogContent>
        <RenameSectionForm key={formKey} slug={slug} section={section} onSaved={close} />
      </DialogContent>
    </Dialog>
  );
}

function RenameSectionForm({
  slug,
  section,
  onSaved,
}: {
  slug: string;
  section: TodoSectionDTO;
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionFeedback(renameSectionAction.bind(null, slug), {
    onSuccess: onSaved,
  });
  return (
    <form action={formAction} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Bölümü yeniden adlandır</DialogTitle>
      </DialogHeader>
      <input type="hidden" name="id" value={section.id} />
      <FormError message={state.ok ? undefined : state.error} />
      <div className="grid gap-1.5">
        <Label htmlFor={`sec-name-${section.id}`}>Bölüm adı</Label>
        <Input
          id={`sec-name-${section.id}`}
          name="name"
          required
          maxLength={120}
          defaultValue={(!state.ok && state.values?.name) || section.name}
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <FieldError errors={state.fieldErrors?.name} />
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Vazgeç</DialogClose>
        <SubmitButton pending={pending} pendingText="Kaydediliyor...">
          Kaydet
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

/** Small inline form at the bottom of a list that adds a section. */
export function AddSectionForm({ slug, listId }: { slug: string; listId: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionFeedback(createSectionAction.bind(null, slug));
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);
  return (
    <form ref={formRef} action={formAction} noValidate className="grid gap-1.5 border-t px-4 py-2">
      <input type="hidden" name="listId" value={listId} />
      <div className="flex gap-2">
        <Input
          name="name"
          required
          maxLength={120}
          placeholder="Yeni bölüm ekle"
          aria-label="Yeni bölüm adı"
          autoComplete="off"
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <SubmitButton pending={pending} variant="outline" aria-label="Bölümü ekle">
          <Plus aria-hidden />
          <span className="hidden sm:inline">Bölüm</span>
        </SubmitButton>
      </div>
      <FieldError errors={state.fieldErrors?.name} />
    </form>
  );
}
