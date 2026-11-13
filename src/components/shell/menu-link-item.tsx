"use client";

import Link from "next/link";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "@/lib/utils";

/**
 * A dropdown-menu item that navigates with next/link.
 * (base-ui: use Menu.LinkItem with render={<Link/>}; there is no asChild.)
 */
export function DropdownMenuLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <MenuPrimitive.LinkItem
      closeOnClick
      render={<Link href={href} />}
      className={cn(
        "relative flex cursor-default items-center gap-1.5 rounded-md pointer-coarse:min-h-10 px-1.5 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
    >
      {children}
    </MenuPrimitive.LinkItem>
  );
}
