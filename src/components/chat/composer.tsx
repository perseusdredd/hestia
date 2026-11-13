"use client";

import { SendHorizontal } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CHAT_MAX_BODY } from "@/lib/pusher/chat-protocol";
import { cn } from "@/lib/utils";

const COUNTER_FROM = CHAT_MAX_BODY - 500;

/** Enter sends, Shift+Enter adds a new line. Trimmed; empty and over-long bodies are rejected. */
export function ChatComposer({ onSend, disabled }: { onSend: (body: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const trimmed = value.trim();
  const tooLong = trimmed.length > CHAT_MAX_BODY;

  function submit() {
    if (disabled) return;
    if (!trimmed) {
      setValue("");
      return;
    }
    if (tooLong) {
      setError(`Mesaj en fazla ${CHAT_MAX_BODY} karakter olabilir.`);
      return;
    }
    onSend(trimmed);
    setValue("");
    setError(null);
    ref.current?.focus();
  }

  return (
    <form
      className="border-t bg-card p-3 sm:p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-end gap-2 rounded-xl border border-input bg-background p-1.5 transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 has-[textarea[aria-invalid=true]]:border-destructive">
        <Textarea
          ref={ref}
          name="body"
          rows={1}
          value={value}
          disabled={disabled}
          placeholder="Mesaj yazın…"
          aria-label="Mesaj"
          aria-invalid={tooLong || Boolean(error)}
          aria-describedby="chat-composer-hint"
          className="max-h-40 min-h-10 resize-none border-0 bg-transparent py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button
          type="submit"
          size="icon-lg"
          disabled={disabled || !trimmed || tooLong}
          aria-label="Gönder"
          className="size-10 shrink-0 rounded-lg"
        >
          <SendHorizontal aria-hidden />
        </Button>
      </div>
      <div id="chat-composer-hint" className="mt-1.5 flex min-h-4 px-1 items-center justify-between gap-3 text-xs">
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : (
          <p className="hidden text-muted-foreground sm:block">
            Göndermek için Enter, yeni satır için Shift + Enter
          </p>
        )}
        {trimmed.length >= COUNTER_FROM ? (
          <span className={cn("ml-auto tabular-nums", tooLong ? "text-destructive" : "text-muted-foreground")}>
            {trimmed.length.toLocaleString("tr-TR")} / {CHAT_MAX_BODY.toLocaleString("tr-TR")}
          </span>
        ) : null}
      </div>
    </form>
  );
}
