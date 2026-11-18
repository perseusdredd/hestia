"use client";

import { ArrowDown, ArrowUp, CalendarDays, MessageCircle, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { memo, useCallback, useState } from "react";

import { deleteItemAction, updateItemAction } from "@/app/w/[slug]/todos/actions";
import { ConfirmAction } from "@/components/confirm-action";
import { DeferredMenu } from "@/components/deferred-menu";
import { FieldError, FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { useActionFeedback } from "@/components/use-action-feedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { cn } from "@/lib/utils";
import type { TodoItemDTO, TodoSectionDTO, TodoUser } from "@/server/todos";

import { formatDueDate } from "@/lib/date-only";

export type RowMenuProps = {
  title: string;
  itemId: string;
  onMove?: (id: string, direction: "up" | "down", button?: HTMLElement) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onEdit: () => void;
  onDelete: () => void;
};

export const rowMenuLabel = (title: string) => `"${title}" için işlemler`;

// The phone overflow menu's code loads after hydration (DeferredMenu).
const loadRowMenu = () => import("@/components/todos/todo-row-menu").then((m) => m.TodoRowMenu);

export function isOverdue(item: Pick<TodoItemDTO, "done" | "dueDate">, today: string): boolean {
  return !item.done && item.dueDate !== null && item.dueDate < today;
}

export const TodoItemRow = memo(function TodoItemRow({
  slug,
  item,
  members,
  today,
  onToggle,
  listOptions,
  onMove,
  canMoveUp,
  canMoveDown,
  commentCount = 0,
  sections = [],
}: {
  slug: string;
  item: TodoItemDTO;
  members: TodoUser[];
  today: string;
  onToggle: (id: string, done: boolean) => void;
  listOptions: { id: string; name: string }[];
  /** Undefined hides the move buttons (e.g. while a filter is on). */
  onMove?: (id: string, direction: "up" | "down", button?: HTMLElement) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Comments on the to-do (from countComments on the page). */
  commentCount?: number;
  /** Sections of the item's list (for the edit form). */
  sections?: TodoSectionDTO[];
}) {
  const overdue = isOverdue(item, today);
  return (
    <li
      className={cn(
        "group relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/50",
        // Overdue: a thin destructive rule on the leading edge, next to the badge.
        overdue && "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-destructive",
      )}
    >
      <Checkbox
        className="mt-1"
        checked={item.done}
        onCheckedChange={(checked) => onToggle(item.id, Boolean(checked))}
        aria-label={`"${item.title}": ${item.done ? "tekrar aç" : "tamamlandı olarak işaretle"}`}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className={cn("break-words text-sm", item.done && "text-muted-foreground line-through")}>
          <Link
            href={`/w/${slug}/todos/${item.id}`}
            className="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {item.title}
          </Link>
        </p>
        {item.notes ? (
          <p className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{item.notes}</p>
        ) : null}
        {item.dueDate || item.startOn || item.assignee || item.extraAssignees.length > 0 || commentCount > 0 ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-0.5 text-xs text-muted-foreground">
            {item.startOn ? (
              <span className="inline-flex h-6 items-center gap-1 rounded-full border bg-background px-2 tabular-nums">
                <CalendarDays className="size-3" aria-hidden />
                <span className="sr-only">Başlangıç: </span>
                {formatDueDate(item.startOn, "d MMM")}
                {item.dueDate ? <span aria-hidden>→</span> : null}
              </span>
            ) : null}
            {item.dueDate ? (
              overdue ? (
                <Badge variant="destructive" className="h-6 px-2 tabular-nums">
                  <CalendarDays aria-hidden /> Gecikti: {formatDueDate(item.dueDate, "d MMM")}
                </Badge>
              ) : (
                <span className="inline-flex h-6 items-center gap-1 rounded-full border bg-background px-2 tabular-nums">
                  <CalendarDays className="size-3" aria-hidden />
                  {formatDueDate(item.dueDate, "d MMM yyyy")}
                </span>
              )
            ) : null}
            {item.assignee ? (
              <span className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border bg-background py-0 pr-2.5 pl-0">
                <UserAvatar user={item.assignee} size="sm" />
                <span className="truncate">{displayName(item.assignee)}</span>
              </span>
            ) : null}
            {item.extraAssignees.map((u) => (
              <span
                key={u.id}
                className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border bg-background py-0 pr-2.5 pl-0"
              >
                <UserAvatar user={u} size="sm" />
                <span className="truncate">{displayName(u)}</span>
              </span>
            ))}
            {commentCount > 0 ? (
              <span className="inline-flex h-6 items-center gap-1 tabular-nums">
                <MessageCircle className="size-3" aria-hidden />
                {commentCount}
                <span className="sr-only"> yorum</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {item.canEdit ? (
        // Phones (coarse pointers): one overflow menu instead of four buttons.
        <RowMenu
          slug={slug}
          item={item}
          members={members}
          listOptions={listOptions}
          onMove={onMove}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          sections={sections}
        />
      ) : null}
      {item.canEdit ? (
        <div className="flex shrink-0 items-center gap-0.5 transition-opacity pointer-coarse:hidden [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
          {onMove ? (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!canMoveUp}
                // Stays focusable when it becomes disabled (first/last after a
                // move), so keyboard focus is not dropped on <body>.
                focusableWhenDisabled
                className="data-disabled:opacity-50"
                onClick={(e) => onMove(item.id, "up", e.currentTarget)}
                aria-label={`"${item.title}" görevini yukarı taşı`}
              >
                <ArrowUp aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!canMoveDown}
                // Stays focusable when it becomes disabled (first/last after a
                // move), so keyboard focus is not dropped on <body>.
                focusableWhenDisabled
                className="data-disabled:opacity-50"
                onClick={(e) => onMove(item.id, "down", e.currentTarget)}
                aria-label={`"${item.title}" görevini aşağı taşı`}
              >
                <ArrowDown aria-hidden />
              </Button>
            </>
          ) : null}
          <EditItemDialog slug={slug} item={item} members={members} listOptions={listOptions} sections={sections} />
          <ConfirmAction
            action={deleteItemAction.bind(null, slug)}
            fields={{ id: item.id }}
            title="Görev silinsin mi?"
            description={`"${item.title}" çöp kutusuna taşınır; 30 gün içinde geri yüklenebilir.`}
            confirmLabel="Sil"
            trigger={<Trash2 aria-hidden />}
            triggerSize="icon-sm"
            triggerLabel={`"${item.title}" görevini sil`}
          />
        </div>
      ) : null}
    </li>
  );
});

function RowMenu({
  slug,
  item,
  members,
  listOptions,
  onMove,
  canMoveUp,
  canMoveDown,
  sections,
}: {
  slug: string;
  item: TodoItemDTO;
  members: TodoUser[];
  listOptions: { id: string; name: string }[];
  sections: TodoSectionDTO[];
  onMove?: (id: string, direction: "up" | "down", button?: HTMLElement) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  const [formKey, setFormKey] = useState(0);
  const close = useCallback(() => setDialog(null), []);
  const openEdit = useCallback(() => {
    setFormKey((k) => k + 1);
    setDialog("edit");
  }, []);
  const openDelete = useCallback(() => {
    setFormKey((k) => k + 1);
    setDialog("delete");
  }, []);
  return (
    <div className="hidden shrink-0 pointer-coarse:block">
      <DeferredMenu
        load={loadRowMenu}
        props={{ title: item.title, itemId: item.id, onMove, canMoveUp, canMoveDown, onEdit: openEdit, onDelete: openDelete }}
        placeholder={(p) => (
          <Button {...p} variant="ghost" size="icon-sm" aria-label={rowMenuLabel(item.title)}>
            <MoreHorizontal aria-hidden />
          </Button>
        )}
      />
      <Dialog open={dialog !== null} onOpenChange={(o) => (!o ? setDialog(null) : undefined)}>
        <DialogContent>
          {dialog === "edit" ? (
            <EditItemForm
              key={formKey}
              slug={slug}
              item={item}
              members={members}
              listOptions={listOptions}
              sections={sections}
              onSaved={close}
            />
          ) : null}
          {dialog === "delete" ? <DeleteItemForm key={formKey} slug={slug} item={item} onDone={close} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DeleteItemForm({ slug, item, onDone }: { slug: string; item: TodoItemDTO; onDone: () => void }) {
  // The row unmounts with the result, so feedback runs inside the action.
  const [state, formAction, pending] = useActionFeedback(deleteItemAction.bind(null, slug), { onSuccess: onDone });
  return (
    <form action={formAction} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Görev silinsin mi?</DialogTitle>
        <DialogDescription>{`"${item.title}" çöp kutusuna taşınır; 30 gün içinde geri yüklenebilir.`}</DialogDescription>
      </DialogHeader>
      <input type="hidden" name="id" value={item.id} />
      <FormError message={state.ok ? undefined : state.error} />
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Vazgeç</DialogClose>
        <SubmitButton pending={pending} variant="destructive">
          Sil
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

function EditItemDialog({
  slug,
  item,
  members,
  listOptions,
  sections,
}: {
  slug: string;
  item: TodoItemDTO;
  members: TodoUser[];
  listOptions: { id: string; name: string }[];
  sections: TodoSectionDTO[];
}) {
  const [open, setOpen] = useState(false);
  // New key on every open: the form (and its action state) starts fresh, so a
  // previous error or rejected values never reappear.
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
        render={<Button variant="ghost" size="icon-sm" aria-label={`"${item.title}" görevini düzenle`} />}
      >
        <Pencil aria-hidden />
      </DialogTrigger>
      <DialogContent>
        <EditItemForm
          key={formKey}
          slug={slug}
          item={item}
          members={members}
          listOptions={listOptions}
          sections={sections}
          onSaved={close}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditItemForm({
  slug,
  item,
  members,
  listOptions,
  sections,
  onSaved,
}: {
  slug: string;
  item: TodoItemDTO;
  members: TodoUser[];
  listOptions: { id: string; name: string }[];
  sections: TodoSectionDTO[];
  onSaved: () => void;
}) {
  // Moving the item to another list unmounts this row with the result, so
  // feedback runs inside the action rather than in an effect.
  const [state, formAction, pending] = useActionFeedback(updateItemAction.bind(null, slug), {
    onSuccess: onSaved,
  });

  const v = state.ok ? undefined : state.values;
  const assigneeDefault = v?.assigneeId ?? item.assigneeId ?? "";
  return (
        <form action={formAction} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Görevi düzenle</DialogTitle>
          </DialogHeader>
          <input type="hidden" name="id" value={item.id} />
          <FormError message={state.ok ? undefined : state.error} />
          <div className="grid gap-1.5">
            <Label htmlFor={`t-title-${item.id}`}>Başlık</Label>
            <Input
              id={`t-title-${item.id}`}
              name="title"
              required
              maxLength={300}
              defaultValue={v?.title ?? item.title}
              aria-invalid={Boolean(state.fieldErrors?.title) || undefined}
            />
            <FieldError errors={state.fieldErrors?.title} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`t-notes-${item.id}`}>Notlar</Label>
            <Textarea
              id={`t-notes-${item.id}`}
              name="notes"
              rows={3}
              maxLength={5000}
              defaultValue={v?.notes ?? item.notes ?? ""}
            />
            <FieldError errors={state.fieldErrors?.notes} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`t-assignee-${item.id}`}>Atanan kişi</Label>
              <NativeSelect
                id={`t-assignee-${item.id}`}
                name="assigneeId"
                // React only applies a <select> defaultValue on mount, and the form
                // is reset after every action: remount so a rejected submit keeps
                // the chosen assignee instead of snapping back.
                key={`a-${assigneeDefault}`}
                defaultValue={assigneeDefault}
              >
                <option value="">Atanmamış</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {displayName(m)}
                  </option>
                ))}
              </NativeSelect>
              <FieldError errors={state.fieldErrors?.assigneeId} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`t-due-${item.id}`}>Bitiş tarihi</Label>
              <Input
                id={`t-due-${item.id}`}
                name="dueDate"
                type="date"
                defaultValue={v?.dueDate ?? item.dueDate ?? ""}
                aria-invalid={Boolean(state.fieldErrors?.dueDate) || undefined}
              />
              <FieldError errors={state.fieldErrors?.dueDate} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`t-start-${item.id}`}>Başlangıç tarihi</Label>
            <Input
              id={`t-start-${item.id}`}
              name="startOn"
              type="date"
              defaultValue={v?.startOn ?? item.startOn ?? ""}
              aria-invalid={Boolean(state.fieldErrors?.startOn) || undefined}
            />
            <FieldError errors={state.fieldErrors?.startOn} />
          </div>
          {members.length > 1 ? (
            <fieldset className="grid gap-1.5">
              <legend className="text-sm font-medium">Ek atananlar</legend>
              {/* Marks that the picker was shown, so submitting replaces extras intentionally. */}
              <input type="hidden" name="extraAssigneesPresent" value="1" />
              <div className="grid max-h-32 gap-1 overflow-y-auto sm:grid-cols-2">
                {members.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="extraAssigneeIds"
                      value={m.id}
                      defaultChecked={item.extraAssignees.some((u) => u.id === m.id)}
                      className="size-4"
                    />
                    <span className="truncate">{displayName(m)}</span>
                  </label>
                ))}
              </div>
              <FieldError errors={state.fieldErrors?.extraAssigneeIds} />
            </fieldset>
          ) : null}
          {sections.length > 0 ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`t-section-${item.id}`}>Bölüm</Label>
              <NativeSelect id={`t-section-${item.id}`} name="sectionId" defaultValue={item.sectionId ?? ""}>
                <option value="">Bölümsüz</option>
                {sections.map((sec) => (
                  <option key={sec.id} value={sec.id}>
                    {sec.name}
                  </option>
                ))}
              </NativeSelect>
              <FieldError errors={state.fieldErrors?.sectionId} />
            </div>
          ) : null}
          {listOptions.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`t-list-${item.id}`}>Listeye taşı</Label>
              <NativeSelect id={`t-list-${item.id}`} name="listId" defaultValue={item.listId}>
                {listOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Vazgeç</DialogClose>
            <SubmitButton pending={pending} pendingText="Kaydediliyor...">
              Kaydet
            </SubmitButton>
          </DialogFooter>
        </form>
  );
}
