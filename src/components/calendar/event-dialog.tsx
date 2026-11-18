"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { MapPin, MessageSquare } from "lucide-react";
import { toast } from "sonner";

import { createEventAction, deleteEventAction, updateEventAction } from "@/app/w/[slug]/calendar/actions";
import { ConfirmAction } from "@/components/confirm-action";
import { FieldError, FormError } from "@/components/form-error";
import { ProjectSelect, type ProjectOption } from "@/components/project-select";
import { SubmitButton } from "@/components/submit-button";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/native-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionState } from "@/lib/action-state";
import { RECURRENCES, RECURRENCE_LABELS } from "@/lib/recurrence";

import type { CalEvent, CalMember } from "./types";

export type DialogTarget =
  | { mode: "create"; dayKey: string }
  | { mode: "edit"; event: CalEvent }
  | null;

export function EventDialog({
  slug,
  target,
  members,
  projects = [],
  onClose,
}: {
  slug: string;
  target: DialogTarget;
  members: CalMember[];
  projects?: ProjectOption[];
  onClose: () => void;
}) {
  const event = target?.mode === "edit" ? target.event : null;
  const readOnly = Boolean(event && !event.canEdit);
  const title = !target ? "" : target.mode === "create" ? "Yeni etkinlik" : readOnly ? "Etkinlik" : "Etkinliği düzenle";

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        {target ? (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                {readOnly
                  ? "Bu etkinliği yalnızca oluşturan kişi veya yöneticiler düzenleyebilir."
                  : "Tarih ve saatler Türkiye saatine göredir."}
              </DialogDescription>
            </DialogHeader>
            <EventForm
              key={event?.id ?? `new-${target.mode === "create" ? target.dayKey : ""}`}
              slug={slug}
              event={event}
              members={members}
              projects={projects}
              defaultDay={target.mode === "create" ? target.dayKey : null}
              readOnly={readOnly}
              onDone={onClose}
            />
            {event ? (
              <Link
                href={`/w/${slug}/calendar/${event.id}`}
                className={buttonVariants({ variant: "outline", size: "sm", className: "w-fit" })}
              >
                <MessageSquare aria-hidden />
                Ayrıntılar
              </Link>
            ) : null}
            {event && !readOnly ? (
              <div className="border-t pt-3">
                <ConfirmAction
                  action={deleteEventAction.bind(null, slug)}
                  fields={{ id: event.id }}
                  title="Etkinlik silinsin mi?"
                  description={`"${event.title}" çöp kutusuna taşınır; 30 gün içinde geri yüklenebilir.`}
                  confirmLabel="Sil"
                  successMessage="Etkinlik silindi."
                  onSuccess={onClose}
                  trigger="Etkinliği sil"
                  triggerVariant="ghost"
                  triggerSize="sm"
                />
              </div>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EventForm({
  slug,
  event,
  members,
  projects,
  defaultDay,
  readOnly,
  onDone,
}: {
  slug: string;
  event: CalEvent | null;
  members: CalMember[];
  projects: ProjectOption[];
  defaultDay: string | null;
  readOnly: boolean;
  onDone: () => void;
}) {
  const action = event ? updateEventAction : createEventAction;
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    action.bind(null, slug),
    {},
  );

  const initialAllDay = state.values ? state.values.allDay === "on" : (event?.allDay ?? false);
  const [allDay, setAllDay] = useState(initialAllDay);
  const day = defaultDay ?? event?.startKey ?? "";
  const [start, setStart] = useState(
    state.values?.startsAt ?? event?.start ?? (day ? `${day}T09:00` : ""),
  );
  const [end, setEnd] = useState(state.values?.endsAt ?? event?.end ?? (day ? `${day}T10:00` : ""));

  const [recurrence, setRecurrence] = useState(state.values?.recurrence ?? event?.recurrence ?? "NONE");

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Kaydedildi.");
      onDone();
    }
  }, [state, onDone]);

  function toggleAllDay(next: boolean) {
    setAllDay(next);
    const fix = (v: string, fallbackTime: string) =>
      next ? v.slice(0, 10) : v.length === 10 ? `${v}T${fallbackTime}` : v;
    setStart((v) => fix(v, "09:00"));
    setEnd((v) => fix(v, "10:00"));
  }

  const fe = state.fieldErrors;
  const v = state.values;

  return (
    <form action={formAction} className="grid gap-4">
      {event ? <input type="hidden" name="id" value={event.id} /> : null}
      <FormError message={state.ok ? undefined : state.error} />

      <div className="grid gap-1.5">
        <Label htmlFor="ev-title">Başlık</Label>
        <Input
          id="ev-title"
          name="title"
          required
          maxLength={200}
          disabled={readOnly}
          defaultValue={v?.title ?? event?.title ?? ""}
          aria-invalid={Boolean(fe?.title)}
        />
        <FieldError errors={fe?.title} />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="allDay"
          checked={allDay}
          disabled={readOnly}
          onChange={(e) => toggleAllDay(e.target.checked)}
          className="size-4 accent-primary"
        />
        Tüm gün
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ev-start">Başlangıç</Label>
          <Input
            id="ev-start"
            name="startsAt"
            type={allDay ? "date" : "datetime-local"}
            required
            disabled={readOnly}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            aria-invalid={Boolean(fe?.startsAt)}
          />
          <FieldError errors={fe?.startsAt} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ev-end">Bitiş</Label>
          <Input
            id="ev-end"
            name="endsAt"
            type={allDay ? "date" : "datetime-local"}
            required
            min={start || undefined}
            disabled={readOnly}
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            aria-invalid={Boolean(fe?.endsAt)}
          />
          <FieldError errors={fe?.endsAt} />
        </div>
      </div>

      {event ? null : (
        <ProjectSelect
          projects={projects}
          id="ev-project"
          defaultValue={state.values?.projectId ?? ""}
          errors={fe?.projectId}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="ev-recurrence">Tekrar</Label>
          <NativeSelect
            id="ev-recurrence"
            name="recurrence"
            disabled={readOnly}
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
          >
            {RECURRENCES.map((r) => (
              <option key={r} value={r}>
                {RECURRENCE_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
          <FieldError errors={fe?.recurrence} />
        </div>
        {recurrence !== "NONE" ? (
          <div className="grid gap-1.5">
            <Label htmlFor="ev-until">Tekrar bitişi (isteğe bağlı)</Label>
            <Input
              id="ev-until"
              name="recurrenceUntil"
              type="date"
              disabled={readOnly}
              defaultValue={v?.recurrenceUntil ?? event?.recurrenceUntil ?? ""}
              aria-invalid={Boolean(fe?.recurrenceUntil)}
            />
            <FieldError errors={fe?.recurrenceUntil} />
          </div>
        ) : null}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="ev-location">Konum</Label>
        <div className="relative">
          <MapPin
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id="ev-location"
            name="location"
            maxLength={200}
            disabled={readOnly}
            className="pl-8"
            defaultValue={v?.location ?? event?.location ?? ""}
          />
        </div>
        <FieldError errors={fe?.location} />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="ev-description">Açıklama</Label>
        <Textarea
          id="ev-description"
          name="description"
          maxLength={5000}
          disabled={readOnly}
          defaultValue={v?.description ?? event?.description ?? ""}
        />
        <FieldError errors={fe?.description} />
      </div>

      {members.length > 0 ? (
        <fieldset className="grid gap-1.5" disabled={readOnly}>
          <legend className="text-sm font-medium">Davetliler</legend>
          <div className="grid max-h-32 gap-1 overflow-y-auto rounded-md border p-2">
            {members.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="inviteeIds"
                  value={m.id}
                  defaultChecked={event?.inviteeIds.includes(m.id) ?? false}
                  className="size-4 accent-primary"
                />
                <span className="min-w-0 truncate">{m.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          {readOnly ? "Kapat" : "Vazgeç"}
        </DialogClose>
        {readOnly ? null : (
          <SubmitButton pending={pending} pendingText="Kaydediliyor">
            {event ? "Kaydet" : "Ekle"}
          </SubmitButton>
        )}
      </DialogFooter>
    </form>
  );
}
