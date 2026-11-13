"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Keeps keyboard focus on a control whose row is moved in the DOM.
 *
 * Reordering a keyed list makes React move the row's element, and the browser
 * blurs a focused element when it is detached, so a keyboard user who pressed
 * "Aşağı taşı" ends up on <body>. Call `remember(button)` in the click handler;
 * after every render, while focus is lost (on <body>), the button gets it back.
 * Any other focus target the user picks ends the hold, and so does time
 * (HOLD_MS covers the optimistic render and the server's revalidation).
 */
const HOLD_MS = 5_000;

export function useKeepFocus() {
  const target = useRef<{ el: HTMLElement; until: number } | null>(null);

  useLayoutEffect(() => {
    if (!target.current) return;
    const { el, until } = target.current;
    if (Date.now() > until) {
      target.current = null;
      return;
    }
    const active = document.activeElement;
    if (active === el) return;
    if (active && active !== document.body) {
      target.current = null;
      return;
    }
    if (el.isConnected) el.focus();
  });

  return useCallback((el: HTMLElement) => {
    target.current = { el, until: Date.now() + HOLD_MS };
  }, []);
}
