"use client";

import { ArrowDown, ArrowUp, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useRef } from "react";

import { type DeferredMenuProps, useFocusOnMount } from "@/components/deferred-menu";
import { rowMenuLabel, type RowMenuProps } from "@/components/todos/todo-item-row";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A to-do row's overflow menu on phones; loaded after hydration (see DeferredMenu). */
export function TodoRowMenu({
  title,
  itemId,
  onMove,
  canMoveUp,
  canMoveDown,
  onEdit,
  onDelete,
  defaultOpen,
  autoFocus,
}: RowMenuProps & DeferredMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  useFocusOnMount(trigger, autoFocus);
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger
        ref={trigger}
        render={<Button variant="ghost" size="icon-sm" aria-label={rowMenuLabel(title)} />}
      >
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {onMove ? (
          <>
            <DropdownMenuItem disabled={!canMoveUp} onClick={() => onMove(itemId, "up", trigger.current ?? undefined)}>
              <ArrowUp aria-hidden />
              Yukarı taşı
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canMoveDown} onClick={() => onMove(itemId, "down", trigger.current ?? undefined)}>
              <ArrowDown aria-hidden />
              Aşağı taşı
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuItem onClick={onEdit}>
          <Pencil aria-hidden />
          Düzenle
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 aria-hidden />
          Sil
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
