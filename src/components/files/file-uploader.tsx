"use client";

import { createContext, useCallback, useContext, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, Loader2, Upload, X } from "lucide-react";

import { completeUploadAction, startUploadAction } from "@/app/w/[slug]/files/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { formatBytes } from "./file-meta";

/** Mirrors the server-side limit (MAX_FILE_SIZE); the server re-checks. */
const MAX_BYTES = 25 * 1024 * 1024;

type UploadItem = {
  key: string;
  name: string;
  size: number;
  progress: number;
  status: "waiting" | "uploading" | "done" | "error";
  error?: string;
};

type Queued = { file: File; key: string; error?: string };

function putWithProgress(
  target: { url: string; method: "PUT"; headers: Record<string, string> },
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url);
    for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = "Dosya yüklenemedi.";
      try {
        const body = JSON.parse(xhr.responseText) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // R2 returns XML errors; keep the generic message.
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Bağlantı hatası. Dosya yüklenemedi."));
    xhr.send(file);
  });
}

type UploadContextValue = {
  busy: boolean;
  /** Queue files; `errors` pre-fails entries that cannot be uploaded (e.g. dropped folders). */
  enqueue: (files: File[], errors?: (string | undefined)[]) => void;
};

const UploadContext = createContext<UploadContextValue | null>(null);

function useUploads(): UploadContextValue {
  const value = useContext(UploadContext);
  if (!value) throw new Error("FileUploader / FileDropZone must be inside <UploadProvider>");
  return value;
}

let keySeq = 0;

/**
 * Upload queue + progress panel shared by the upload button and the drop
 * zone. Each file goes through three steps: startUploadAction (server
 * validates and issues the key/target), a direct PUT to storage, and
 * completeUploadAction (server verifies, creates the row). Files upload one
 * at a time; files added while busy join the queue.
 */
export function UploadProvider({
  slug,
  folderId,
  children,
}: {
  slug: string;
  folderId: string | null;
  children: React.ReactNode;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const queue = useRef<Queued[]>([]);
  const running = useRef(false);
  const [, startTransition] = useTransition();
  const router = useRouter();

  const update = useCallback(
    (key: string, patch: Partial<UploadItem>) =>
      setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it))),
    [],
  );

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    let anyDone = false;
    for (let next = queue.current.shift(); next; next = queue.current.shift()) {
      const { file, key, error } = next;
      if (error) {
        update(key, { status: "error", error });
        continue;
      }
      if (file.size > MAX_BYTES) {
        update(key, { status: "error", error: "Dosya en fazla 25 MB olabilir." });
        continue;
      }
      update(key, { status: "uploading" });
      try {
        const started = await startUploadAction(slug, {
          name: file.name,
          size: file.size,
          type: file.type,
          folderId,
        });
        if (!started.ok || !started.data) throw new Error(started.error ?? "Yükleme başlatılamadı.");
        await putWithProgress(started.data, file, (p) => update(key, { progress: p }));
        const done = await completeUploadAction(slug, started.data.token);
        if (!done.ok) throw new Error(done.error ?? "Yükleme tamamlanamadı.");
        update(key, { status: "done", progress: 1 });
        anyDone = true;
      } catch (e) {
        update(key, {
          status: "error",
          error: e instanceof Error && e.message ? e.message : "Dosya yüklenemedi.",
        });
      }
    }
    running.current = false;
    setBusy(false);
    if (anyDone) startTransition(() => router.refresh());
  }, [folderId, router, slug, update]);

  const enqueue = useCallback(
    (files: File[], errors: (string | undefined)[] = []) => {
      if (!files.length) return;
      const added = files.map((file, i) => ({ file, key: `u${++keySeq}`, error: errors[i] }));
      queue.current.push(...added);
      setItems((prev) => [
        ...(running.current ? prev : prev.filter((p) => p.status !== "done")),
        ...added.map((q) => ({
          key: q.key,
          name: q.file.name,
          size: q.file.size,
          progress: 0,
          status: "waiting" as const,
        })),
      ]);
      void drain();
    },
    [drain],
  );

  const doneCount = items.filter((i) => i.status === "done").length;

  return (
    <UploadContext.Provider value={{ busy, enqueue }}>
      {children}
      {items.length > 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-4 bottom-4 z-40 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg sm:inset-x-auto sm:right-6 sm:w-96"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {busy ? "Dosyalar yükleniyor" : `Yükleme bitti (${doneCount}/${items.length})`}
            </p>
            {!busy ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Yükleme listesini kapat"
                onClick={() => setItems([])}
              >
                <X aria-hidden />
              </Button>
            ) : null}
          </div>
          <ul className="max-h-60 space-y-2 overflow-y-auto">
            {items.map((it) => (
              <li key={it.key} className="text-sm">
                <div className="flex items-center gap-2">
                  {it.status === "done" ? (
                    <CircleCheck className="size-4 shrink-0 text-primary-text" aria-hidden />
                  ) : it.status === "error" ? (
                    <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
                  ) : (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate">{it.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {it.status === "waiting" ? "Sırada · " : null}
                    {formatBytes(it.size)}
                  </span>
                </div>
                {it.status === "uploading" || it.status === "waiting" ? (
                  <div
                    className="mt-1 ml-6 h-1 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={`${it.name} yükleniyor`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(it.progress * 100)}
                  >
                    <div
                      className={cn("h-full rounded-full bg-primary transition-[width]")}
                      style={{ width: `${Math.round(it.progress * 100)}%` }}
                    />
                  </div>
                ) : null}
                {it.status === "error" ? (
                  <p className="mt-0.5 ml-6 text-xs text-destructive">{it.error}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </UploadContext.Provider>
  );
}

/** Upload button (the keyboard-accessible path; the drop zone is an extra). */
export function FileUploader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { busy, enqueue } = useUploads();
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          enqueue(files);
        }}
      />
      <Button type="button" onClick={() => inputRef.current?.click()} aria-busy={busy}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
        {busy ? "Yükleniyor" : "Dosya yükle"}
      </Button>
    </>
  );
}

function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

/**
 * Drop target around the file list: dropping files queues them in the
 * shared uploader. Dropped folders are listed with an error (not uploaded).
 */
export function FileDropZone({ children, className }: { children: React.ReactNode; className?: string }) {
  const { enqueue } = useUploads();
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  return (
    <div
      data-dropzone
      className={cn("relative", className)}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setActive(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setActive(false);
        const files: File[] = [];
        const errors: (string | undefined)[] = [];
        const items = Array.from(e.dataTransfer.items ?? []);
        if (items.length) {
          for (const item of items) {
            if (item.kind !== "file") continue;
            const file = item.getAsFile();
            if (!file) continue;
            const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
            files.push(file);
            errors.push(entry?.isDirectory ? "Klasörler yüklenemez; içindeki dosyaları seçin." : undefined);
          }
        } else {
          files.push(...Array.from(e.dataTransfer.files));
        }
        enqueue(files, errors);
      }}
    >
      {children}
      {active ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-background/85 text-center"
        >
          <Upload className="size-6 text-primary-text" aria-hidden />
          <p className="text-sm font-medium">Dosyaları buraya bırakın</p>
          <p className="text-xs text-muted-foreground">Dosya başına en fazla 25 MB</p>
        </div>
      ) : null}
    </div>
  );
}
