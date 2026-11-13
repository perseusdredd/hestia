"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode, type Ref, type RefObject } from "react";

/** Props every deferred menu module receives on top of its own. */
export type DeferredMenuProps = {
  /** Open as soon as it mounts (the trigger was pressed before the code arrived). */
  defaultOpen: boolean;
  /** Focus the trigger on mount (the placeholder had focus when it was swapped). */
  autoFocus: boolean;
};

/** Handlers and attributes the placeholder trigger must spread onto its <button>. */
export type PlaceholderProps = {
  ref: Ref<HTMLButtonElement>;
  onPointerEnter: () => void;
  onFocus: () => void;
  onClick: () => void;
  "aria-haspopup": "menu";
  "aria-expanded": false;
};

type Loader<P> = () => Promise<ComponentType<P & DeferredMenuProps>>;

// One request per menu module, shared by every instance (the layout renders
// the workspace switcher twice) and kept across client navigations.
const pending = new Map<unknown, Promise<unknown>>();
const loaded = new Map<unknown, unknown>();

function ensure<P>(load: Loader<P>): Promise<ComponentType<P & DeferredMenuProps>> {
  let p = pending.get(load) as Promise<ComponentType<P & DeferredMenuProps>> | undefined;
  if (!p) {
    p = load().then((C) => {
      loaded.set(load, C);
      return C;
    });
    // A failed chunk request (offline) may be retried on the next hover/press.
    p.catch(() => pending.delete(load));
    pending.set(load, p);
  }
  return p;
}

function whenIdle(fn: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(fn, { timeout: 2_000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 200);
  return () => window.clearTimeout(id);
}

/**
 * Keeps a dropdown menu's code (base-ui Menu + floating-ui, about 60 kB
 * gzipped) out of the first load of every page that shows one.
 *
 * Until the module has arrived, `placeholder` renders a plain button that looks
 * exactly like the menu's trigger. The module is fetched when the browser is
 * idle after hydration, or at once on hover, focus or press. A press made
 * before it arrives opens the menu as soon as it does; if the placeholder had
 * focus, the real trigger takes it over, so keyboard users never land on <body>.
 *
 * `load` must be a module-level function (`() => import("./x").then(m => m.X)`)
 * so the bundler gives the menu its own chunk.
 */
export function DeferredMenu<P extends object>({
  load,
  props,
  placeholder,
  onRequestOpen,
}: {
  load: Loader<P>;
  props: P;
  placeholder: (p: PlaceholderProps) => ReactNode;
  /** Called when the placeholder is pressed (the real menu's onOpenChange does not fire for defaultOpen). */
  onRequestOpen?: () => void;
}) {
  const [state, setState] = useState<{ Menu: ComponentType<P & DeferredMenuProps>; focus: boolean } | null>(null);
  const [openRequested, setOpenRequested] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  const start = useCallback(() => {
    void ensure(load)
      .then((Menu) => setState((s) => s ?? { Menu, focus: document.activeElement === button.current && button.current !== null }))
      .catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (loaded.has(load)) {
      start();
      return;
    }
    return whenIdle(start);
  }, [load, start]);

  if (state) {
    const { Menu, focus } = state;
    // When it opens at once, the menu moves focus into its popup itself (and
    // back to the trigger on close).
    return <Menu {...props} defaultOpen={openRequested} autoFocus={focus && !openRequested} />;
  }
  return placeholder({
    ref: button,
    onPointerEnter: start,
    onFocus: start,
    onClick: () => {
      setOpenRequested(true);
      onRequestOpen?.();
      start();
    },
    "aria-haspopup": "menu",
    "aria-expanded": false,
  });
}

/** Focuses `ref` once after mount when `when` is true (see DeferredMenuProps.autoFocus). */
export function useFocusOnMount(ref: RefObject<HTMLElement | null>, when: boolean) {
  const done = useRef(false);
  useEffect(() => {
    if (when && !done.current) {
      done.current = true;
      ref.current?.focus();
    }
  }, [ref, when]);
}
