"use client";

import { ArrowDown, ArrowUp, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useActionState, useCallback, useEffect, useOptimistic, useRef, useState, startTransition } from "react";
import { toast } from "sonner";

import {
  createItemAction,
  deleteListAction,
  moveItemAction,
  moveListAction,
  toggleItemAction,
} from "@/app/w/[slug]/todos/actions";
import { ConfirmAction } from "@/components/confirm-action";
import { FieldError } from "@/components/form-error";
import { useKeepFocus } from "@/components/use-keep-focus";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/submit-button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/native-select";
import { Input } from "@/components/ui/input";
import type { ActionState } from "@/lib/action-state";
import { cn } from "@/lib/utils";
import type { TodoListDTO, TodoSectionDTO, TodoUser } from "@/server/todos";

import { HillChart } from "./hill-chart";
import { InternalBadge } from "@/components/internal-toggle";
import { EditListButton } from "./list-dialogs";
import { AddSectionForm, SectionHeader } from "./section-controls";
import { TodoItemRow } from "./todo-item-row";

export function TodoListCard({
  slug,
  list,
  members,
  today,
  readOnlyAdd = false,
  listOptions,
  canReorder,
  isFirst,
  isLast,
  commentCounts = {},
  canSetInternal = false,
}: {
  slug: string;
  list: TodoListDTO;
  /** Shows the "Yalnızca ekip" toggle in the edit dialog (not for guests). */
  canSetInternal?: boolean;
  members: TodoUser[];
  today: string;
  /** Hide the add form (e.g. while the "assigned to me" filter is on). */
  readOnlyAdd?: boolean;
  listOptions: { id: string; name: string }[];
  /** False while a filter hides lists or items (moves would be ambiguous). */
  canReorder: boolean;
  isFirst: boolean;
  isLast: boolean;
  /** Comment count per item id (items without comments are absent). */
  commentCounts?: Record<string, number>;
}) {
  const [items, applyToggle] = useOptimistic(
    list.items,
    (current, change: { id: string; done: boolean } | { id: string; move: "up" | "down" }) => {
      if ("move" in change) {
        const index = current.findIndex((i) => i.id === change.id);
        if (index === -1) return current;
        const group = current[index];
        const step = change.move === "up" ? -1 : 1;
        let j = index + step;
        while (j >= 0 && j < current.length && (current[j].done !== group.done || current[j].sectionId !== group.sectionId)) j += step;
        if (j < 0 || j >= current.length) return current;
        const next = [...current];
        const [x] = next.splice(index, 1);
        next.splice(j, 0, x);
        return next;
      }
      return current.map((i) =>
        i.id === change.id
          ? { ...i, done: change.done, completedAt: change.done ? new Date().toISOString() : null }
          : i,
      );
    },
  );

  // Stable handlers: TodoItemRow is memoised, so toggling one item re-renders
  // only that row (and the progress bar), not every row of the list.
  const onToggle = useCallback(
    (id: string, done: boolean) => {
      startTransition(async () => {
        applyToggle({ id, done });
        const res = await toggleItemAction(slug, id, done);
        if (!res.ok) toast.error(res.error ?? "Görev güncellenemedi.");
      });
    },
    [slug, applyToggle],
  );

  // A moved row's element is re-inserted by React, which blurs its focused
  // button; keep focus on it (and on the list's own move buttons).
  const keepItemFocus = useKeepFocus();
  const keepListFocus = useKeepFocus();
  const onMove = useCallback(
    (id: string, move: "up" | "down", button?: HTMLElement) => {
      if (button) keepItemFocus(button);
      startTransition(async () => {
        applyToggle({ id, move });
        const res = await moveItemAction(slug, id, move);
        if (!res.ok) toast.error(res.error ?? "Görev taşınamadı.");
      });
    },
    [slug, applyToggle, keepItemFocus],
  );
  // Completed rows mount only while "Tamamlananlar" is open: a list with
  // hundreds of finished items no longer renders them (menus, dialogs) hidden.
  const [showDone, setShowDone] = useState(false);

  function onMoveList(move: "up" | "down", button: HTMLElement) {
    keepListFocus(button);
    startTransition(async () => {
      const res = await moveListAction(slug, list.id, move);
      if (!res.ok) toast.error(res.error ?? "Liste taşınamadı.");
    });
  }

  // Progress follows the optimistic state; the server total covers items hidden by the filter.
  // Items hidden by the filter (completed items beyond the per-list cap are not "hidden").
  const hidden = list.total - list.items.length - list.hiddenDone;
  const optimisticDone = items.filter((i) => i.done).length;
  const baseDone = list.items.filter((i) => i.done).length;
  const doneCount = list.doneCount - baseDone + optimisticDone;
  const percent = list.total === 0 ? 0 : Math.round((doneCount / list.total) * 100);

  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);

  // Optional sections: items without a (known) section render first, ungrouped, exactly as before.
  const sectionIds = new Set(list.sections.map((sec) => sec.id));
  const ungroupedOpen = open.filter((i) => !i.sectionId || !sectionIds.has(i.sectionId));
  const renderOpenRows = (rows: typeof open) => (
    <ul className="divide-y">
      {rows.map((item, index) => (
        <TodoItemRow
          key={item.id}
          slug={slug}
          item={item}
          members={members}
          today={today}
          onToggle={onToggle}
          listOptions={listOptions}
          onMove={canReorder ? onMove : undefined}
          canMoveUp={canReorder && index > 0}
          canMoveDown={canReorder && index < rows.length - 1}
          commentCount={commentCounts[item.id] ?? 0}
          sections={list.sections}
        />
      ))}
    </ul>
  );

  return (
    <Card className="gap-0 py-0 shadow-xs">
      <div className="space-y-3 border-b px-4 pt-3.5 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 pt-0.5">
            <h2 className="flex flex-wrap items-center gap-2 break-words text-section-title">
              {list.name}
              {list.internal ? <InternalBadge /> : null}
            </h2>
            {list.description ? (
              <p className="mt-0.5 whitespace-pre-line text-sm text-muted-foreground">
                {list.description}
              </p>
            ) : null}
          </div>
          {list.canEdit ? (
            <div className="flex shrink-0 items-center">
              {canReorder ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={isFirst}
                    focusableWhenDisabled
                    className="data-disabled:opacity-50"
                    onClick={(e) => onMoveList("up", e.currentTarget)}
                    aria-label={`"${list.name}" listesini yukarı taşı`}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={isLast}
                    focusableWhenDisabled
                    className="data-disabled:opacity-50"
                    onClick={(e) => onMoveList("down", e.currentTarget)}
                    aria-label={`"${list.name}" listesini aşağı taşı`}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                </>
              ) : null}
              <EditListButton slug={slug} list={list} canSetInternal={canSetInternal} />
              <ConfirmAction
                action={deleteListAction.bind(null, slug)}
                fields={{ id: list.id }}
                title="Liste silinsin mi?"
                description={`"${list.name}" ve içindeki ${list.total} görev çöp kutusuna taşınır; 30 gün içinde geri yüklenebilir.`}
                confirmLabel="Listeyi sil"
                trigger={<Trash2 aria-hidden />}
                triggerSize="icon-sm"
                triggerLabel="Listeyi sil"
              />
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={`${list.name} ilerlemesi`}
            className="h-2 flex-1 overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-border"
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-300",
                percent === 100 ? "bg-success" : "bg-primary",
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            <span className="font-medium text-foreground">
              {doneCount}/{list.total}
            </span>{" "}
            tamamlandı
          </span>
        </div>
      </div>

      <HillChart
        key={`${list.id}-${list.hillPosition}`}
        slug={slug}
        listId={list.id}
        listName={list.name}
        position={list.hillPosition}
        note={list.hillNote}
      />

      {items.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          Bu listede henüz görev yok.
        </p>
      ) : (
        <>
          {open.length > 0 || list.sections.length > 0 ? (
            <>
              {ungroupedOpen.length > 0 ? renderOpenRows(ungroupedOpen) : null}
              {list.sections.map((sec, secIndex) => {
                const rows = open.filter((i) => i.sectionId === sec.id);
                if (readOnlyAdd && rows.length === 0) return null;
                return (
                  <div key={sec.id}>
                    <SectionHeader
                      slug={slug}
                      section={sec}
                      count={rows.length}
                      canEdit={list.canEdit && canReorder}
                      isFirst={secIndex === 0}
                      isLast={secIndex === list.sections.length - 1}
                    />
                    {rows.length > 0 ? renderOpenRows(rows) : null}
                  </div>
                );
              })}
              {open.length === 0 ? (
                <p className="px-4 py-4 text-center text-sm text-muted-foreground">Açık görev kalmadı.</p>
              ) : null}
            </>
          ) : (
            <p className="px-4 py-4 text-center text-sm text-muted-foreground">
              Açık görev kalmadı.
            </p>
          )}
          {done.length > 0 ? (
            <details className="group/done border-t" onToggle={(e) => setShowDone(e.currentTarget.open)}>
              <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
                <ChevronRight
                  className="size-4 transition-transform group-open/done:rotate-90"
                  aria-hidden
                />
                Tamamlananlar ({done.length + list.hiddenDone})
              </summary>
              {showDone ? (
                <ul className="divide-y border-t">
                  {done.map((item, index) => (
                    <TodoItemRow
                      key={item.id}
                      slug={slug}
                      item={item}
                      members={members}
                      today={today}
                      onToggle={onToggle}
                      listOptions={listOptions}
                      onMove={canReorder ? onMove : undefined}
                      canMoveUp={canReorder && index > 0}
                      canMoveDown={canReorder && index < done.length - 1}
                      commentCount={commentCounts[item.id] ?? 0}
                      sections={list.sections}
                    />
                  ))}
                </ul>
              ) : null}
              {showDone && list.hiddenDone > 0 ? (
                <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                  İlk {done.length} tamamlanan görev gösteriliyor; {list.hiddenDone} görev daha var. Bir görevi
                  bulmak için aramayı kullanın.
                </p>
              ) : null}
            </details>
          ) : null}
        </>
      )}

      {hidden > 0 ? (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          Filtre nedeniyle {hidden} görev gizlendi.
        </p>
      ) : null}

      {readOnlyAdd ? null : <AddItemForm slug={slug} listId={list.id} sections={list.sections} />}
      {readOnlyAdd || !list.canEdit ? null : <AddSectionForm slug={slug} listId={list.id} />}
    </Card>
  );
}

function AddItemForm({
  slug,
  listId,
  sections,
}: {
  slug: string;
  listId: string;
  sections: TodoSectionDTO[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createItemAction.bind(null, slug),
    {},
  );

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      action={action}
      noValidate
      className="grid gap-1.5 border-t bg-muted/30 px-4 py-3"
    >
      <input type="hidden" name="listId" value={listId} />
      <div className="flex gap-2">
        <Input
          name="title"
          required
          maxLength={300}
          placeholder="Yeni görev ekle"
          aria-label="Yeni görev başlığı"
          autoComplete="off"
          defaultValue={state.ok ? "" : state.values?.title}
          key={state.ok ? "ok" : `v-${state.values?.title ?? ""}`}
          aria-invalid={Boolean(state.fieldErrors?.title || (!state.ok && state.error)) || undefined}
        />
        <SubmitButton
          pending={pending}
          variant="secondary"
          aria-label="Görevi ekle"
          className="pointer-coarse:min-w-10"
        >
          <Plus aria-hidden />
          <span className="hidden sm:inline">Ekle</span>
        </SubmitButton>
      </div>
      {sections.length > 0 ? (
        <NativeSelect name="sectionId" defaultValue="" aria-label="Bölüm">
          <option value="">Bölümsüz</option>
          {sections.map((sec) => (
            <option key={sec.id} value={sec.id}>
              {sec.name}
            </option>
          ))}
        </NativeSelect>
      ) : null}
      <FieldError errors={state.fieldErrors?.title} />
      {!state.ok && state.error && !state.fieldErrors?.title ? (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
