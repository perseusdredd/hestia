"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Download, FolderInput, Lock, LockOpen, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";

import { setFolderInternalAction } from "@/app/w/[slug]/files/actions";
import { documentHref, downloadHref } from "@/app/w/[slug]/files/paths";
import { type DeferredMenuProps, useFocusOnMount } from "@/components/deferred-menu";
import { itemMenuLabel, type ItemMenuProps } from "@/components/files/item-actions";
import { DropdownMenuLink } from "@/components/shell/menu-link-item";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A file, document or folder's "..." menu; loaded after hydration (see DeferredMenu). */
export function ItemMenu({
  slug,
  item,
  canModify,
  current,
  onDialog,
  canSetInternal,
  defaultOpen,
  autoFocus,
}: ItemMenuProps & DeferredMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  useFocusOnMount(trigger, autoFocus);
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger
        ref={trigger}
        render={
          current ? (
            <Button variant="outline" aria-label={itemMenuLabel(item, true)} />
          ) : (
            <Button variant="ghost" size="icon-sm" aria-label={itemMenuLabel(item, false)} />
          )
        }
      >
        <MoreHorizontal aria-hidden />
        {current ? "Klasör" : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {item.kind === "file" ? (
          <MenuPrimitive.LinkItem
            closeOnClick
            render={<a href={downloadHref(item.id)} download />}
            className="relative flex cursor-default items-center gap-1.5 rounded-md pointer-coarse:min-h-10 px-1.5 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
          >
            <Download aria-hidden />
            İndir
          </MenuPrimitive.LinkItem>
        ) : null}
        {item.kind === "document" && canModify ? (
          <DropdownMenuLink href={`${documentHref(slug, item.id)}/edit`}>
            <Pencil aria-hidden />
            Düzenle
          </DropdownMenuLink>
        ) : null}
        {canModify && item.kind !== "document" ? (
          <DropdownMenuItem onClick={() => onDialog("rename")}>
            <Pencil aria-hidden />
            Yeniden adlandır
          </DropdownMenuItem>
        ) : null}
        {canModify && canSetInternal && item.kind === "folder" ? (
          <DropdownMenuItem
            onClick={async () => {
              const res = await setFolderInternalAction(slug, item.id, !item.internal);
              if (res.ok) toast.success(res.message);
              else toast.error(res.error ?? "İşlem yapılamadı.");
            }}
          >
            {item.internal ? <LockOpen aria-hidden /> : <Lock aria-hidden />}
            {item.internal ? "Misafirlere aç" : "Yalnızca ekip yap"}
          </DropdownMenuItem>
        ) : null}
        {canModify ? (
          <DropdownMenuItem onClick={() => onDialog("move")}>
            <FolderInput aria-hidden />
            Taşı
          </DropdownMenuItem>
        ) : null}
        {canModify ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onDialog("delete")}>
              <Trash2 aria-hidden />
              Sil
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
