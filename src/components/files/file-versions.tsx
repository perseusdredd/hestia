"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Upload } from "lucide-react";

import { completeVersionUploadAction, startVersionUploadAction } from "@/app/w/[slug]/files/actions";
import { downloadHref, versionDownloadHref } from "@/app/w/[slug]/files/paths";
import { Button } from "@/components/ui/button";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatDateTime } from "@/lib/format";

import { formatBytes } from "./file-meta";

const MAX_BYTES = 25 * 1024 * 1024;

export type VersionRow = {
  id: string | null;
  version: number;
  size: number;
  current: boolean;
  createdAt: string;
  uploadedBy: { id: string; name: string | null; email: string; image: string | null };
};

function put(
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
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Dosya yüklenemedi."));
    xhr.onerror = () => reject(new Error("Bağlantı hatası. Dosya yüklenemedi."));
    xhr.send(file);
  });
}

/** Version history of a file with the "Yeni sürüm" upload (team members who may modify the file). */
export function FileVersions({
  slug,
  fileId,
  versions,
  canUpload,
}: {
  slug: string;
  fileId: string;
  versions: VersionRow[];
  canUpload: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_BYTES) return setError("Dosya en fazla 25 MB olabilir.");
    setBusy(true);
    setProgress(0);
    try {
      const started = await startVersionUploadAction(slug, { fileId, size: file.size, type: file.type });
      if (!started.ok || !started.data) throw new Error(started.error ?? "Yükleme başlatılamadı.");
      await put(started.data, file, setProgress);
      const done = await completeVersionUploadAction(slug, started.data.token);
      if (!done.ok) throw new Error(done.error ?? "Yükleme tamamlanamadı.");
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Dosya yüklenemedi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {canUpload ? (
        <>
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              void onPick(f);
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => inputRef.current?.click()}
            aria-busy={busy}
            disabled={busy}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
            {busy ? `Yükleniyor %${Math.round(progress * 100)}` : "Yeni sürüm"}
          </Button>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <ol className="space-y-2 text-sm" aria-label="Sürüm geçmişi">
        {versions.map((v) => (
          <li key={v.id ?? "current"} className="flex items-start gap-2">
            <UserAvatar user={v.uploadedBy} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                Sürüm {v.version}
                {v.current ? <span className="ml-1 text-xs font-normal text-muted-foreground">(güncel)</span> : null}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {displayName(v.uploadedBy)} · {formatBytes(v.size)}
              </p>
              <time className="text-xs text-muted-foreground" dateTime={v.createdAt}>
                {formatDateTime(new Date(v.createdAt))}
              </time>
            </div>
            <a
              href={v.id ? versionDownloadHref(fileId, v.id) : downloadHref(fileId)}
              download
              aria-label={`Sürüm ${v.version} dosyasını indir`}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Download className="size-4" aria-hidden />
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
