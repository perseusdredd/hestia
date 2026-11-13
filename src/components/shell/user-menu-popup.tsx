"use client";

import { LayoutGrid, LogOut, Plus, UserRound } from "lucide-react";
import { useTheme } from "next-themes";
import { useRef, useTransition } from "react";

import { signOutAction } from "@/app/(auth)/actions";
import { type DeferredMenuProps, useFocusOnMount } from "@/components/deferred-menu";
import { DropdownMenuLink } from "@/components/shell/menu-link-item";
import { userMenuLabel, UserMenuTriggerContent, type UserMenuProps } from "@/components/shell/user-menu";
import { THEME_OPTIONS, useMounted } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { displayName } from "@/components/user-avatar";

/** The real account menu; loaded after hydration by UserMenu (see DeferredMenu). */
export function UserMenuPopup({ user, defaultOpen, autoFocus }: UserMenuProps & DeferredMenuProps) {
  const [pending, startTransition] = useTransition();
  const trigger = useRef<HTMLButtonElement>(null);
  useFocusOnMount(trigger, autoFocus);
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger
        ref={trigger}
        render={
          <Button variant="ghost" size="icon" className="rounded-full" aria-label={userMenuLabel(user)} />
        }
      >
        <UserMenuTriggerContent user={user} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="grid gap-0.5 py-1.5">
            <span className="truncate text-sm font-medium text-foreground">{displayName(user)}</span>
            <span className="truncate text-xs font-normal">{user.email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLink href="/account">
          <UserRound aria-hidden />
          Hesabım
        </DropdownMenuLink>
        <DropdownMenuLink href="/app">
          <LayoutGrid aria-hidden />
          Çalışma alanlarım
        </DropdownMenuLink>
        <DropdownMenuLink href="/onboarding">
          <Plus aria-hidden />
          Yeni çalışma alanı
        </DropdownMenuLink>
        <DropdownMenuSeparator />
        <ThemeMenuGroup />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={pending}
          onClick={() => startTransition(() => signOutAction())}
        >
          <LogOut aria-hidden />
          Çıkış yap
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The theme switch (ThemeToggle) as menu radio items. */
function ThemeMenuGroup() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Tema</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={mounted ? (theme ?? "system") : ""}
        onValueChange={(value) => setTheme(String(value))}
      >
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={value} value={value} closeOnClick={false}>
            <Icon aria-hidden />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}
