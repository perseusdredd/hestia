"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";

import { FieldError, FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionState } from "@/lib/action-state";

import {
  createCardAction,
  createColumnAction,
  moveCardColumnAction,
  moveCardDirectionAction,
  moveColumnAction,
  renameColumnAction,
  updateCardAction,
} from "./actions";

function useToastOnOk(state: ActionState) {
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);
}

export type MemberOption = { id: string; label: string };

type CardValues = { title: string; notes: string | null; assigneeId: string | null; dueOn: string | null };

function CardFields({
  idPrefix,
  members,
  card,
  state,
}: {
  idPrefix: string;
  members: MemberOption[];
  card?: CardValues;
  state: ActionState;
}) {
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-title`}>Başlık</Label>
        <Input
          id={`${idPrefix}-title`}
          name="title"
          required
          maxLength={300}
          defaultValue={card?.title ?? ""}
          aria-invalid={Boolean(state.fieldErrors?.title) || undefined}
        />
        <FieldError errors={state.fieldErrors?.title} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-notes`}>Notlar</Label>
        <Textarea id={`${idPrefix}-notes`} name="notes" rows={3} maxLength={5000} defaultValue={card?.notes ?? ""} />
        <FieldError errors={state.fieldErrors?.notes} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-assignee`}>Atanan</Label>
          <NativeSelect id={`${idPrefix}-assignee`} name="assigneeId" defaultValue={card?.assigneeId ?? ""}>
            <option value="">Kimse</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </NativeSelect>
          <FieldError errors={state.fieldErrors?.assigneeId} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-due`}>Son tarih</Label>
          <Input id={`${idPrefix}-due`} name="dueOn" type="date" defaultValue={card?.dueOn ?? ""} />
          <FieldError errors={state.fieldErrors?.dueOn} />
        </div>
      </div>
    </>
  );
}

export function AddCardForm({ slug, columnId, members }: { slug: string; columnId: string; members: MemberOption[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createCardAction.bind(null, slug, columnId),
    {},
  );
  useToastOnOk(state);
  return (
    <details className="rounded-lg border bg-background px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">Kart ekle</summary>
      <form action={action} className="mt-3 grid gap-3" key={state.ok ? "done" : "open"}>
        <CardFields idPrefix={`add-${columnId}`} members={members} state={state} />
        <FormError message={state.ok ? null : state.error} />
        <div>
          <SubmitButton pending={pending} size="sm">
            Ekle
          </SubmitButton>
        </div>
      </form>
    </details>
  );
}

export function EditCardForm({
  slug,
  cardId,
  card,
  members,
}: {
  slug: string;
  cardId: string;
  card: CardValues;
  members: MemberOption[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateCardAction.bind(null, slug, cardId),
    {},
  );
  useToastOnOk(state);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">Düzenle</summary>
      <form action={action} className="mt-2 grid gap-3">
        <CardFields idPrefix={`edit-${cardId}`} members={members} card={card} state={state} />
        <FormError message={state.ok ? null : state.error} />
        <div>
          <SubmitButton pending={pending} size="sm">
            Kaydet
          </SubmitButton>
        </div>
      </form>
    </details>
  );
}

/**
 * Small icon-less button that posts a bound server action (move / reorder).
 * Failures are toasted; success just re-renders the board.
 */
export function StepButton({
  action,
  label,
  children,
  disabled,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});
  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state]);
  return (
    <form action={formAction}>
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={disabled || pending}
        aria-label={label}
        title={label}
      >
        {children}
      </Button>
    </form>
  );
}

export function CardMoveControls({
  slug,
  cardId,
  prevColumnId,
  nextColumnId,
  isFirst,
  isLast,
}: {
  slug: string;
  cardId: string;
  prevColumnId: string | null;
  nextColumnId: string | null;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      <StepButton
        action={prevColumnId ? moveCardColumnAction.bind(null, slug, cardId, prevColumnId) : noop}
        label="Önceki sütuna taşı"
        disabled={!prevColumnId}
      >
        ←
      </StepButton>
      <StepButton
        action={moveCardDirectionAction.bind(null, slug, cardId, "up")}
        label="Yukarı taşı"
        disabled={isFirst}
      >
        ↑
      </StepButton>
      <StepButton
        action={moveCardDirectionAction.bind(null, slug, cardId, "down")}
        label="Aşağı taşı"
        disabled={isLast}
      >
        ↓
      </StepButton>
      <StepButton
        action={nextColumnId ? moveCardColumnAction.bind(null, slug, cardId, nextColumnId) : noop}
        label="Sonraki sütuna taşı"
        disabled={!nextColumnId}
      >
        →
      </StepButton>
    </div>
  );
}

async function noop(): Promise<ActionState> {
  return {};
}

export function AddColumnForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createColumnAction.bind(null, slug), {});
  useToastOnOk(state);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" key={state.ok ? "done" : "open"}>
      <div className="grid gap-1.5">
        <Label htmlFor="new-column-name">Yeni sütun</Label>
        <Input id="new-column-name" name="name" required maxLength={60} placeholder="Sütun adı" />
      </div>
      <SubmitButton pending={pending} size="sm">
        Sütun ekle
      </SubmitButton>
      <FormError message={state.ok ? null : state.error} className="w-full" />
    </form>
  );
}

export function ColumnManagerRow({
  slug,
  columnId,
  name,
  isFirst,
  isLast,
}: {
  slug: string;
  columnId: string;
  name: string;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    renameColumnAction.bind(null, slug, columnId),
    {},
  );
  useToastOnOk(state);
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <form action={action} className="flex items-center gap-2">
          <Label htmlFor={`col-${columnId}`} className="sr-only">
            Sütun adı
          </Label>
          <Input id={`col-${columnId}`} name="name" required maxLength={60} defaultValue={name} className="w-48" />
          <SubmitButton pending={pending} size="sm" variant="outline">
            Yeniden adlandır
          </SubmitButton>
        </form>
        <StepButton action={moveColumnAction.bind(null, slug, columnId, "up")} label="Sütunu sola taşı" disabled={isFirst}>
          ←
        </StepButton>
        <StepButton action={moveColumnAction.bind(null, slug, columnId, "down")} label="Sütunu sağa taşı" disabled={isLast}>
          →
        </StepButton>
      </div>
      <FormError message={state.ok ? null : state.error} />
    </div>
  );
}
