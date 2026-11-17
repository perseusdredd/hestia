"use client";

import { ImagePlus, Loader2, SendHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_TYPES, CHAT_MAX_BODY } from "@/lib/pusher/chat-protocol";
import { cn } from "@/lib/utils";

const COUNTER_FROM = CHAT_MAX_BODY - 500;

const IMAGE_ACCEPT = CHAT_IMAGE_TYPES.join(",");

/**
 * Enter sends, Shift+Enter adds a new line. Trimmed; empty and over-long bodies are rejected.
 * A photo (button, or pasted from the clipboard) is sent together with the text as its caption.
 */
export function ChatComposer({
  onSend,
  onSendImage,
  sendingImage,
  disabled,
}: {
  onSend: (body: string) => void;
  onSendImage: (file: File, caption: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  sendingImage?: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const trimmed = value.trim();
  const tooLong = trimmed.length > CHAT_MAX_BODY;
  const busy = Boolean(sendingImage);

  // Release the preview's object URL when it is replaced or the composer unmounts.
  useEffect(() => {
    return () => {
      if (photo) URL.revokeObjectURL(photo.url);
    };
  }, [photo]);

  function pick(file: File | undefined | null) {
    if (!file) return;
    if (!(CHAT_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      setError("Yalnızca JPEG, PNG, WebP veya GIF fotoğraf gönderebilirsiniz.");
      return;
    }
    if (file.size > CHAT_IMAGE_MAX_BYTES) {
      setError("Fotoğraf en fazla 10 MB olabilir.");
      return;
    }
    setError(null);
    setPhoto({ file, url: URL.createObjectURL(file) });
    ref.current?.focus();
  }

  async function submit() {
    if (disabled || busy) return;
    if (tooLong) {
      setError(`Mesaj en fazla ${CHAT_MAX_BODY} karakter olabilir.`);
      return;
    }
    if (photo) {
      setError(null);
      const res = await onSendImage(photo.file, trimmed);
      if (res.ok) {
        setPhoto(null);
        setValue("");
        ref.current?.focus();
      } else {
        setError(res.error);
      }
      return;
    }
    if (!trimmed) {
      setValue("");
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
        void submit();
      }}
    >
      {photo ? (
        <div className="mb-2 flex items-center gap-3 rounded-lg border bg-background p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
          <img src={photo.url} alt="Seçilen fotoğraf" className="size-16 shrink-0 rounded-md object-cover" />
          <p className="min-w-0 flex-1 truncate text-sm">{photo.file.name}</p>
          {busy ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Gönderiliyor…
            </span>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Fotoğrafı kaldır"
              onClick={() => setPhoto(null)}
            >
              <X aria-hidden />
            </Button>
          )}
        </div>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept={IMAGE_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <div className="flex items-end gap-2 rounded-xl border border-input bg-background p-1.5 transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 has-[textarea[aria-invalid=true]]:border-destructive">
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          disabled={disabled || busy}
          aria-label="Fotoğraf ekle"
          className="size-10 shrink-0 rounded-lg"
          onClick={() => fileRef.current?.click()}
        >
          <ImagePlus aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || busy}
          className="h-10 shrink-0 rounded-lg px-2 text-sm"
          onClick={() => {
            setValue((v) => (/@claude\b/i.test(v) ? v : `@Claude ${v}`));
            ref.current?.focus();
          }}
        >
          @Claude
        </Button>
        <Textarea
          ref={ref}
          name="body"
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={photo ? "Fotoğrafa bir not ekleyin (isteğe bağlı)…" : "Mesaj yazın…"}
          aria-label="Mesaj"
          aria-invalid={tooLong || Boolean(error)}
          aria-describedby="chat-composer-hint"
          className="max-h-40 min-h-10 resize-none border-0 bg-transparent py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onPaste={(e) => {
            const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
            if (file) {
              e.preventDefault();
              pick(file);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <Button
          type="submit"
          size="icon-lg"
          disabled={disabled || busy || (!trimmed && !photo) || tooLong}
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
