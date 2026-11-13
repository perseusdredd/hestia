"use client";

import { Pencil, Plus } from "lucide-react";
import { useActionState, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { createListAction, updateListAction } from "@/app/w/[slug]/todos/actions";
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
import { Textarea } from "@/components/ui/textarea";
import type { ActionState } from "@/lib/action-state";

function ListForm({
  title,
  submitLabel,
  action,
  listId,
  initial,
  trigger,
}: {
  title: string;
  submitLabel: string;
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  listId?: string;
  initial?: { name: string; description: string | null };
  trigger: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  // New key on every open: fresh action state, no stale error or rejected values.
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
      <DialogTrigger render={trigger} />
      <DialogContent>
        <ListFormBody
          key={formKey}
          title={title}
          submitLabel={submitLabel}
          action={action}
          listId={listId}
          initial={initial}
          onSaved={close}
        />
      </DialogContent>
    </Dialog>
  );
}

function ListFormBody({
  title,
  submitLabel,
  action,
  listId,
  initial,
  onSaved,
}: {
  title: string;
  submitLabel: string;
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  listId?: string;
  initial?: { name: string; description: string | null };
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  useEffect(() => {
    if (state.ok) {
      onSaved();
      if (state.message) toast.success(state.message);
    }
  }, [state, onSaved]);

  const nameDefault = state.ok ? (initial?.name ?? "") : (state.values?.name ?? initial?.name ?? "");
  const descDefault = state.ok
    ? (initial?.description ?? "")
    : (state.values?.description ?? initial?.description ?? "");

  return (
        <form action={formAction} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {listId ? <input type="hidden" name="id" value={listId} /> : null}
          <FormError message={state.ok ? undefined : state.error} />
          <div className="grid gap-1.5">
            <Label htmlFor={`list-name-${listId ?? "new"}`}>Liste adı</Label>
            <Input
              id={`list-name-${listId ?? "new"}`}
              name="name"
              required
              maxLength={120}
              autoFocus
              defaultValue={nameDefault}
              aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
            />
            <FieldError errors={state.fieldErrors?.name} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`list-desc-${listId ?? "new"}`}>Açıklama (isteğe bağlı)</Label>
            <Textarea
              id={`list-desc-${listId ?? "new"}`}
              name="description"
              rows={3}
              maxLength={2000}
              defaultValue={descDefault}
              aria-invalid={Boolean(state.fieldErrors?.description) || undefined}
            />
            <FieldError errors={state.fieldErrors?.description} />
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Vazgeç</DialogClose>
            <SubmitButton pending={pending} pendingText="Kaydediliyor...">
              {submitLabel}
            </SubmitButton>
          </DialogFooter>
        </form>
  );
}

export function NewListButton({ slug }: { slug: string }) {
  return (
    <ListForm
      title="Yeni liste"
      submitLabel="Oluştur"
      action={createListAction.bind(null, slug)}
      trigger={
        <Button>
          <Plus aria-hidden />
          Yeni liste
        </Button>
      }
    />
  );
}

export function EditListButton({
  slug,
  list,
}: {
  slug: string;
  list: { id: string; name: string; description: string | null };
}) {
  return (
    <ListForm
      title="Listeyi düzenle"
      submitLabel="Kaydet"
      action={updateListAction.bind(null, slug)}
      listId={list.id}
      initial={list}
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label="Listeyi düzenle">
          <Pencil aria-hidden />
        </Button>
      }
    />
  );
}
