"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

import { MAIN_ID } from "@/components/skip-link";

/**
 * After a client-side route change, move keyboard focus to <main> when it
 * would otherwise be lost (on <body>, on a removed element) or left behind in
 * the header / navigation. Screen readers then start at the new content, and
 * the next Tab continues from there. Query-string changes (filters, paging)
 * keep focus where it is. Next's route announcer still reads the new title.
 */
export function RouteFocus() {
  const pathname = usePathname();
  const previous = useRef(pathname);

  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const main = document.getElementById(MAIN_ID);
    if (!main) return;
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    const inChrome = Boolean(active?.closest("header, nav, aside"));
    if (lost || (inChrome && !main.contains(active))) main.focus({ preventScroll: true });
  }, [pathname]);

  return null;
}
