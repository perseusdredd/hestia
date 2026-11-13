"use client";

import { ChevronsUpDown } from "lucide-react";

import { DeferredMenu } from "@/components/deferred-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type WorkspaceOption = { id: string; name: string; slug: string };

export type WorkspaceSwitcherProps = {
  current: WorkspaceOption;
  workspaces: WorkspaceOption[];
  className?: string;
};

const loadMenu = () => import("@/components/shell/workspace-switcher-popup").then((m) => m.WorkspaceSwitcherPopup);

export function WorkspaceMark({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md bg-primary-soft text-xs font-semibold text-primary-text",
        className,
      )}
      aria-hidden
    >
      {name.slice(0, 1).toLocaleUpperCase("tr")}
    </span>
  );
}

export const switcherTriggerClass = (className?: string) => cn("h-9 min-w-0 justify-start gap-2 px-2", className);

export function SwitcherTriggerContent({ name }: { name: string }) {
  return (
    <>
      <WorkspaceMark name={name} />
      {/* The accessible name starts with the visible name (WCAG 2.5.3). */}
      <span className="truncate font-medium">
        {name}
        <span className="sr-only">, çalışma alanını değiştir</span>
      </span>
      <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" aria-hidden />
    </>
  );
}

/** Workspace switcher. Its menu code loads after hydration (DeferredMenu). */
export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  return (
    <DeferredMenu
      load={loadMenu}
      props={props}
      placeholder={(p) => (
        <Button {...p} variant="ghost" className={switcherTriggerClass(props.className)}>
          <SwitcherTriggerContent name={props.current.name} />
        </Button>
      )}
    />
  );
}
