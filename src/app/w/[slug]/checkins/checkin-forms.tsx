"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";

import { FieldError, FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionState } from "@/lib/action-state";

import {
  answerCheckinAction,
  createQuestionAction,
  setQuestionActiveAction,
  updateQuestionAction,
} from "./actions";
import { WEEKDAY_OPTIONS } from "./weekdays";

function useToastOnOk(state: ActionState) {
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);
}

export function AnswerForm({ slug, roundId, initial }: { slug: string; roundId: string; initial: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    answerCheckinAction.bind(null, slug, roundId),
    {},
  );
  useToastOnOk(state);
  return (
    <form action={action} className="grid gap-2">
      <Label htmlFor={`answer-${roundId}`} className="sr-only">
        Cevabınız
      </Label>
      <Textarea
        id={`answer-${roundId}`}
        name="body"
        required
        maxLength={5000}
        rows={3}
        placeholder="Cevabınızı yazın…"
        defaultValue={initial}
        aria-invalid={Boolean(state.fieldErrors?.body) || undefined}
      />
      <FieldError errors={state.fieldErrors?.body} />
      <FormError message={state.ok ? null : state.error} />
      <div>
        <SubmitButton pending={pending} size="sm">
          {initial ? "Cevabı güncelle" : "Cevapla"}
        </SubmitButton>
      </div>
    </form>
  );
}

type QuestionValues = { text: string; weekdays: number[]; hour: number };

function QuestionFields({ idPrefix, q, state }: { idPrefix: string; q?: QuestionValues; state: ActionState }) {
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-text`}>Soru</Label>
        <Input
          id={`${idPrefix}-text`}
          name="text"
          required
          maxLength={300}
          defaultValue={q?.text ?? ""}
          placeholder="Bu hafta neler üzerinde çalışıyorsunuz?"
          aria-invalid={Boolean(state.fieldErrors?.text) || undefined}
        />
        <FieldError errors={state.fieldErrors?.text} />
      </div>
      <fieldset className="grid gap-1.5">
        <legend className="text-sm font-medium">Günler</legend>
        <div className="flex flex-wrap gap-3">
          {WEEKDAY_OPTIONS.map((d) => (
            <label key={d.value} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                name="weekdays"
                value={d.value}
                defaultChecked={q ? q.weekdays.includes(d.value) : d.value === 1}
                className="size-4"
              />
              {d.label}
            </label>
          ))}
        </div>
        <FieldError errors={state.fieldErrors?.weekdays} />
      </fieldset>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-hour`}>Saat (İstanbul)</Label>
        <NativeSelect id={`${idPrefix}-hour`} name="hour" defaultValue={String(q?.hour ?? 9)} className="w-32">
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, "0")}:00
            </option>
          ))}
        </NativeSelect>
        <FieldError errors={state.fieldErrors?.hour} />
      </div>
    </>
  );
}

export function CreateQuestionForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createQuestionAction.bind(null, slug), {});
  useToastOnOk(state);
  return (
    <form action={action} className="grid gap-3">
      <QuestionFields idPrefix="new-q" state={state} />
      <FormError message={state.ok ? null : state.error} />
      <div>
        <SubmitButton pending={pending} size="sm">
          Soru ekle
        </SubmitButton>
      </div>
    </form>
  );
}

export function EditQuestionForm({ slug, id, q }: { slug: string; id: string; q: QuestionValues }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateQuestionAction.bind(null, slug, id),
    {},
  );
  useToastOnOk(state);
  return (
    <form action={action} className="grid gap-3">
      <QuestionFields idPrefix={`q-${id}`} q={q} state={state} />
      <FormError message={state.ok ? null : state.error} />
      <div>
        <SubmitButton pending={pending} size="sm" variant="outline">
          Kaydet
        </SubmitButton>
      </div>
    </form>
  );
}

export function ActiveToggle({ slug, id, active }: { slug: string; id: string; active: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    setQuestionActiveAction.bind(null, slug, id, !active),
    {},
  );
  useToastOnOk(state);
  return (
    <form action={action}>
      <SubmitButton pending={pending} size="sm" variant="outline">
        {active ? "Durdur" : "Etkinleştir"}
      </SubmitButton>
    </form>
  );
}
