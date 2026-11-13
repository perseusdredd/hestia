import { CalendarDays, Check, CheckSquare, FileText, FolderOpen, MessageCircle, MessageSquare, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A static, decorative picture of a workspace for the landing page, built
 * from the same tokens and shapes as the real screens (no screenshot, no
 * numbers). Hidden from assistive technology and contains nothing focusable.
 */

const NAV: { icon: LucideIcon; label: string; active?: boolean }[] = [
  { icon: MessageSquare, label: "Mesajlar" },
  { icon: CheckSquare, label: "Yapılacaklar", active: true },
  { icon: FolderOpen, label: "Dosyalar" },
  { icon: CalendarDays, label: "Takvim" },
];

const TODOS: { title: string; done?: boolean; due?: string; who?: string }[] = [
  { title: "Logo taslaklarını paylaş", done: true },
  { title: "Ana sayfa metnini onayla", due: "Cuma", who: "A" },
  { title: "Fatura bilgilerini gönder", who: "M" },
];

function Avatar({ letter, className }: { letter: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[10px] font-semibold text-primary-text",
        className,
      )}
    >
      {letter}
    </span>
  );
}

export function WorkspacePreview({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none select-none", className)}>
      <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        {/* Window bar */}
        <div className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-border-strong" />
          <span className="size-2.5 rounded-full bg-border-strong" />
          <span className="size-2.5 rounded-full bg-border-strong" />
          <span className="ml-2 text-xs font-medium text-muted-foreground">Yeni web sitesi</span>
        </div>

        <div className="grid grid-cols-[8.5rem_minmax(0,1fr)]">
          <div className="space-y-0.5 border-r bg-sidebar p-2">
            {NAV.map(({ icon: Icon, label, active }) => (
              <div
                key={label}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                  active ? "bg-primary-soft font-medium text-primary-text" : "text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </div>
            ))}
          </div>

          <div className="space-y-3 p-3">
            <div className="rounded-xl border bg-background">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="text-xs font-semibold">Tasarım turu</span>
                <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full w-1/3 rounded-full bg-primary" />
                </span>
              </div>
              <ul className="divide-y">
                {TODOS.map((t) => (
                  <li key={t.title} className="flex items-center gap-2 px-3 py-2">
                    <span
                      className={cn(
                        "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border",
                        t.done ? "border-primary bg-primary text-primary-foreground" : "border-input",
                      )}
                    >
                      {t.done ? <Check className="size-2.5" strokeWidth={3} /> : null}
                    </span>
                    <span
                      className={cn("min-w-0 flex-1 truncate text-xs", t.done && "text-muted-foreground line-through")}
                    >
                      {t.title}
                    </span>
                    {t.due ? (
                      <span className="rounded-full border px-1.5 text-[10px] text-muted-foreground">{t.due}</span>
                    ) : null}
                    {t.who ? <Avatar letter={t.who} /> : null}
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl border bg-background p-3">
              <div className="flex items-center gap-2">
                <Avatar letter="M" />
                <span className="text-xs font-semibold">Renk paleti için iki seçenek</span>
              </div>
              <div className="mt-2 flex gap-1.5">
                <span className="h-4 flex-1 rounded bg-primary" />
                <span className="h-4 flex-1 rounded bg-primary-soft" />
                <span className="h-4 flex-1 rounded bg-secondary" />
                <span className="h-4 flex-1 rounded bg-muted" />
              </div>
              <div className="mt-2.5 flex items-start gap-2 rounded-lg bg-muted/60 px-2 py-1.5">
                <MessageCircle className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                <span className="text-[11px] leading-snug text-muted-foreground">
                  <span className="rounded bg-primary-soft px-1 font-medium text-primary-text">@Ayşe</span> ikinci
                  seçenek daha sıcak duruyor.
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-xl border bg-background px-3 py-2">
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">site-haritasi.pdf</span>
              <span className="text-[10px] text-muted-foreground">PDF</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
