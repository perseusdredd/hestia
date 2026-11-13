"use client";

import { Search } from "lucide-react";
import { useEffect } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH } from "@/lib/search-limits";

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/**
 * Search box in the workspace shell: a plain GET form to /w/[slug]/search
 * (works without JavaScript). With `shortcut`, "/" or Ctrl/⌘+K focuses the
 * visible search box.
 */
export function ShellSearch({
  slug,
  id,
  shortcut = false,
  className,
}: {
  slug: string;
  id: string;
  shortcut?: boolean;
  className?: string;
}) {
  useEffect(() => {
    if (!shortcut) return;
    function onKeyDown(e: KeyboardEvent) {
      const isK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
      const isSlash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target);
      if (!isK && !isSlash) return;
      // Focus whichever shell search box is visible (desktop header or mobile row).
      const target = [...document.querySelectorAll<HTMLInputElement>("input[data-shell-search]")].find(
        (el) => el.offsetParent !== null,
      );
      if (!target) return;
      e.preventDefault();
      target.focus();
      target.select();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcut]);

  return (
    <form
      action={`/w/${slug}/search`}
      method="get"
      role="search"
      aria-label="Çalışma alanında ara"
      className={cn("relative", className)}
    >
      <label htmlFor={id} className="sr-only">
        Çalışma alanında ara
      </label>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        id={id}
        name="q"
        type="search"
        required
        minLength={SEARCH_MIN_LENGTH}
        maxLength={SEARCH_MAX_LENGTH}
        placeholder="Ara…"
        autoComplete="off"
        enterKeyHint="search"
        data-shell-search=""
        className={cn("h-8 bg-background pl-8 pointer-coarse:h-10", shortcut && "pr-12")}
      />
      {shortcut ? (
        <kbd
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground lg:inline"
        >
          Ctrl K
        </kbd>
      ) : null}
    </form>
  );
}
