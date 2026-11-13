"use client";

import { useRef } from "react";

import type { ConfirmDialogProps } from "@/components/confirm-action";
import { type DeferredMenuProps, useFocusOnMount } from "@/components/deferred-menu";
import { FormError } from "@/components/form-error";
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

/** ConfirmAction's dialog; loaded after hydration (see DeferredMenu). */
export function ConfirmDialog({
  open,
  setOpen,
  formAction,
  pending,
  error,
  fields,
  title,
  description,
  confirmLabel,
  destructive,
  trigger,
  triggerVariant,
  triggerSize,
  triggerLabel,
  autoFocus,
}: ConfirmDialogProps & DeferredMenuProps) {
  const trigger_ = useRef<HTMLButtonElement>(null);
  useFocusOnMount(trigger_, autoFocus);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        ref={trigger_}
        render={<Button variant={triggerVariant} size={triggerSize} aria-label={triggerLabel} />}
      >
        {trigger}
      </DialogTrigger>
      <DialogContent>
        <form action={formAction} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          {fields
            ? Object.entries(fields).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))
            : null}
          <FormError message={error} />
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Vazgeç</DialogClose>
            <SubmitButton pending={pending} variant={destructive ? "destructive" : "default"}>
              {confirmLabel}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
