"use client";

import { useCallback, useMemo, useState } from "react";
import { MoreHorizontal } from "lucide-react";

import {
  deleteCurrentFolderAction,
  deleteItemAction,
  moveItemAction,
  renameItemAction,
} from "@/app/w/[slug]/files/actions";
import { FieldError, FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { DeferredMenu } from "@/components/deferred-menu";
import { SubmitButton } from "@/components/submit-button";
import { useActionFeedback } from "@/components/use-action-feedback";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";

import { buildFolderOptions, type FolderNode } from "./folder-options";

export type ItemKind = "folder" | "file" | "document";

export type ActionItem = {
  kind: ItemKind;
  id: string;
  name: string;
  /** Folder the item currently lives in (parentId for folders). */
  locationId: string | null;
};

const KIND_LABEL: Record<ItemKind, string> = { folder: "Klasör", file: "Dosya", document: "Doküman" };

export type ItemDialog = "rename" | "move" | "delete";

export type ItemMenuProps = {
  slug: string;
  item: ActionItem;
  canModify: boolean;
  current: boolean;
  onDialog: (d: ItemDialog) => void;
};

export const itemMenuLabel = (item: ActionItem, current: boolean) =>
  current ? `Klasör işlemleri: ${item.name}` : `${item.name} için işlemler`;

// The "..." menu's code loads after hydration (DeferredMenu).
const loadItemMenu = () => import("@/components/files/item-menu").then((m) => m.ItemMenu);

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

function useDialogAction(action: Action, onDone: () => void) {
  // Move and delete take the row (and this dialog) out of the folder view in
  // the same render that delivers the result, so feedback runs in the action.
  const [state, formAction, pending] = useActionFeedback(action, { onSuccess: onDone });
  return { state, formAction, pending };
}

function Hidden({ item }: { item: ActionItem }) {
  return (
    <>
      <input type="hidden" name="kind" value={item.kind} />
      <input type="hidden" name="id" value={item.id} />
    </>
  );
}

function RenameForm({ slug, item, onDone }: { slug: string; item: ActionItem; onDone: () => void }) {
  const { state, formAction, pending } = useDialogAction(renameItemAction.bind(null, slug), onDone);
  const value = state.values?.name ?? item.name;
  return (
    <form action={formAction} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Yeniden adlandır</DialogTitle>
        <DialogDescription>{KIND_LABEL[item.kind]} için yeni bir ad girin.</DialogDescription>
      </DialogHeader>
      <Hidden item={item} />
      <FormError message={state.ok || state.fieldErrors?.name ? undefined : state.error} />
      <div className="grid gap-1.5">
        <Label htmlFor={`rename-${item.id}`}>Ad</Label>
        <Input
          id={`rename-${item.id}`}
          name="name"
          required
          maxLength={item.kind === "folder" ? 120 : 200}
          autoFocus
          autoComplete="off"
          defaultValue={value}
          key={value}
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <FieldError errors={state.fieldErrors?.name} />
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Vazgeç</DialogClose>
        <SubmitButton pending={pending} pendingText="Kaydediliyor">
          Kaydet
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

function MoveForm({
  slug,
  item,
  folders,
  onDone,
}: {
  slug: string;
  item: ActionItem;
  folders: FolderNode[];
  onDone: () => void;
}) {
  const { state, formAction, pending } = useDialogAction(moveItemAction.bind(null, slug), onDone);
  const options = useMemo(
    () => buildFolderOptions(folders, item.kind === "folder" ? item.id : undefined),
    [folders, item.id, item.kind],
  );
  return (
    <form action={formAction} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Taşı</DialogTitle>
        <DialogDescription>
          “{item.name}” için hedef klasörü seçin.
          {item.kind === "folder" ? " Klasör, içindekilerle birlikte taşınır." : null}
        </DialogDescription>
      </DialogHeader>
      <Hidden item={item} />
      <FormError message={state.ok ? undefined : state.error} />
      <div className="grid gap-1.5">
        <Label htmlFor={`move-${item.id}`}>Hedef klasör</Label>
        <NativeSelect id={`move-${item.id}`} name="targetFolderId" defaultValue={item.locationId ?? ""}>
          <option value="">Dosyalar (ana klasör)</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Vazgeç</DialogClose>
        <SubmitButton pending={pending} pendingText="Taşınıyor">
          Taşı
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

function DeleteForm({
  slug,
  item,
  current,
  onDone,
}: {
  slug: string;
  item: ActionItem;
  current: boolean;
  onDone: () => void;
}) {
  // Deleting the open folder redirects to its parent (the page would 404).
  const { state, formAction, pending } = useDialogAction(
    (current ? deleteCurrentFolderAction : deleteItemAction).bind(null, slug),
    onDone,
  );
  const description =
    item.kind === "folder"
      ? "Klasör, içindeki tüm alt klasörler, dosyalar ve dokümanlarla birlikte çöp kutusuna taşınır; 30 gün içinde geri yüklenebilir."
      : "Çöp kutusuna taşınır; 30 gün içinde geri yüklenebilir.";
  return (
    <form action={formAction} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>“{item.name}” silinsin mi?</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <Hidden item={item} />
      <FormError message={state.ok ? undefined : state.error} />
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Vazgeç</DialogClose>
        <SubmitButton pending={pending} variant="destructive" pendingText="Siliniyor">
          Sil
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

/**
 * Per-row "..." menu. Edit actions are shown only when `canModify` (the
 * server re-checks every permission). `current` renders a labelled trigger
 * for the folder that is open (page header) and redirects after a delete.
 */
export function ItemActions({
  slug,
  item,
  canModify,
  folders,
  current = false,
}: {
  slug: string;
  item: ActionItem;
  canModify: boolean;
  folders: FolderNode[];
  current?: boolean;
}) {
  const [dialog, setDialog] = useState<ItemDialog | null>(null);
  const close = useCallback(() => setDialog(null), []);

  if (!canModify && item.kind !== "file") return null;

  return (
    <>
      <DeferredMenu
        load={loadItemMenu}
        props={{ slug, item, canModify, current, onDialog: setDialog }}
        placeholder={(p) =>
          current ? (
            <Button {...p} variant="outline" aria-label={itemMenuLabel(item, true)}>
              <MoreHorizontal aria-hidden />
              Klasör
            </Button>
          ) : (
            <Button {...p} variant="ghost" size="icon-sm" aria-label={itemMenuLabel(item, false)}>
              <MoreHorizontal aria-hidden />
            </Button>
          )
        }
      />

      <Dialog open={dialog !== null} onOpenChange={(open) => (!open ? setDialog(null) : undefined)}>
        <DialogContent>
          {dialog === "rename" ? <RenameForm slug={slug} item={item} onDone={close} /> : null}
          {dialog === "move" ? <MoveForm slug={slug} item={item} folders={folders} onDone={close} /> : null}
          {dialog === "delete" ? <DeleteForm slug={slug} item={item} current={current} onDone={close} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
