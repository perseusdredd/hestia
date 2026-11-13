"use client";

import { Check, Plus } from "lucide-react";
import { useRef } from "react";

import { type DeferredMenuProps, useFocusOnMount } from "@/components/deferred-menu";
import { DropdownMenuLink } from "@/components/shell/menu-link-item";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SwitcherTriggerContent,
  switcherTriggerClass,
  WorkspaceMark,
  type WorkspaceSwitcherProps,
} from "@/components/shell/workspace-switcher";

/** The real workspace menu; loaded after hydration by WorkspaceSwitcher (see DeferredMenu). */
export function WorkspaceSwitcherPopup({
  current,
  workspaces,
  className,
  defaultOpen,
  autoFocus,
}: WorkspaceSwitcherProps & DeferredMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  useFocusOnMount(trigger, autoFocus);
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger ref={trigger} render={<Button variant="ghost" className={switcherTriggerClass(className)} />}>
        <SwitcherTriggerContent name={current.name} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Çalışma alanları</DropdownMenuLabel>
          {workspaces.map((w) => (
            <DropdownMenuLink key={w.id} href={`/w/${w.slug}`}>
              <WorkspaceMark name={w.name} className="size-5 text-[10px]" />
              <span className="truncate">{w.name}</span>
              {w.id === current.id ? <Check className="ml-auto" aria-label="Seçili" /> : null}
            </DropdownMenuLink>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLink href="/onboarding">
          <Plus aria-hidden />
          Yeni çalışma alanı
        </DropdownMenuLink>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
