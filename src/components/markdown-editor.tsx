"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// react-markdown + remark-gfm (~50 kB gzipped) load only when "Önizle" is opened.
const Markdown = dynamic(() => import("@/components/markdown").then((m) => m.Markdown), {
  ssr: false,
  loading: () => <p className="text-sm text-muted-foreground">Önizleme yükleniyor…</p>,
});

type Props = Omit<React.ComponentProps<"textarea">, "value" | "onChange"> & {
  previewEmptyText?: string;
};

/**
 * Textarea with a "Yaz / Önizle" toggle. The textarea stays mounted (hidden in preview),
 * so the form field name, native reset and submit behave exactly as before.
 */
export function MarkdownEditor({ className, previewEmptyText = "Önizlenecek bir şey yok.", ...props }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [preview, setPreview] = useState("");

  function show(next: "write" | "preview") {
    if (next === "preview") setPreview(ref.current?.value ?? "");
    setMode(next);
  }

  const tab = (active: boolean) =>
    cn(
      "inline-flex min-h-8 items-center justify-center rounded-md px-3 text-xs font-medium transition-colors pointer-coarse:min-h-10 pointer-coarse:min-w-12",
      active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="grid gap-1.5">
      <div role="group" aria-label="Görünüm" className="inline-flex w-fit gap-0.5 rounded-lg bg-muted p-[3px]">
        <button type="button" aria-pressed={mode === "write"} className={tab(mode === "write")} onClick={() => show("write")}>
          Yaz
        </button>
        <button
          type="button"
          aria-pressed={mode === "preview"}
          className={tab(mode === "preview")}
          onClick={() => show("preview")}
        >
          Önizle
        </button>
      </div>
      <Textarea ref={ref} {...props} className={cn(className, mode === "preview" && "hidden")} />
      {mode === "preview" ? (
        <div className="min-h-16 rounded-lg border border-input px-2.5 py-2">
          {preview.trim() ? <Markdown text={preview} /> : <p className="text-sm text-muted-foreground">{previewEmptyText}</p>}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Markdown desteklenir: **kalın**, *italik*, `kod`, - liste, [bağlantı](https://…), # başlık, tablo ve - [ ] görev.
      </p>
    </div>
  );
}
