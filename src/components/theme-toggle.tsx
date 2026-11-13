"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

export const THEME_OPTIONS = [
  { value: "light", label: "Açık", icon: Sun },
  { value: "dark", label: "Koyu", icon: Moon },
  { value: "system", label: "Sistem", icon: Monitor },
] as const;

const subscribe = () => () => {};

export function useMounted() {
  // next-themes only knows the stored theme on the client; avoid a hydration mismatch.
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/** Light / dark / system switch backed by next-themes (ThemeProvider is in the root layout). */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const active = mounted ? (theme ?? "system") : null;

  return (
    <div
      role="radiogroup"
      aria-label="Tema"
      className={cn("inline-flex rounded-lg border p-0.5", className)}
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const selected = active === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 pointer-coarse:h-10 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
              selected
                ? "bg-primary-soft font-medium text-primary-text"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
