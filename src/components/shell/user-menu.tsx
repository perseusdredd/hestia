"use client";

import { DeferredMenu } from "@/components/deferred-menu";
import { Button } from "@/components/ui/button";
import { initials, UserAvatar } from "@/components/user-avatar";

export type UserMenuProps = { user: { name: string | null; email: string; image: string | null } };

const loadMenu = () => import("@/components/shell/user-menu-popup").then((m) => m.UserMenuPopup);

/**
 * "Hesap menüsü, EE": the initials the avatar shows are the trigger's only
 * visible text, so they are part of its name (WCAG 2.5.3, label in name);
 * speech-input users can say what they see. (axe matches whole words, so
 * no brackets around them.)
 */
export const userMenuLabel = (user: UserMenuProps["user"]) => `Hesap menüsü, ${initials(user.name, user.email)}`;

export function UserMenuTriggerContent({ user }: UserMenuProps) {
  // The name comes from aria-label (userMenuLabel); the avatar adds nothing to it.
  return (
    <span aria-hidden className="contents">
      <UserAvatar user={user} size="sm" />
    </span>
  );
}

/** Account menu in the header. Its menu code loads after hydration (DeferredMenu). */
export function UserMenu({ user }: UserMenuProps) {
  return (
    <DeferredMenu
      load={loadMenu}
      props={{ user }}
      placeholder={(p) => (
        <Button {...p} variant="ghost" size="icon" className="rounded-full" aria-label={userMenuLabel(user)}>
          <UserMenuTriggerContent user={user} />
        </Button>
      )}
    />
  );
}
