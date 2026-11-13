"use client";

import { useSyncExternalStore } from "react";
import { ExternalLink } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

const QUERY = "(min-width: 768px) and (pointer: fine)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * PDF preview. The inline response sandboxes itself through its own CSP
 * header; the <iframe> must NOT carry a sandbox attribute, because
 * Chromium's PDF viewer refuses to load in sandboxed frames. Phones (no
 * embedded viewer) and anyone else get the "PDF'i aç" link to a new tab.
 */
export function PdfPreview({ src, name }: { src: string; name: string }) {
  const embed = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
  return (
    <div className="space-y-3">
      {embed ? (
        <iframe
          src={src}
          title={`PDF önizlemesi: ${name}`}
          className="h-[70vh] w-full rounded-lg border bg-muted"
          referrerPolicy="no-referrer"
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          PDF bu ekranda gömülü gösterilmiyor. Yeni sekmede açabilir ya da indirebilirsiniz.
        </p>
      )}
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonVariants({ variant: "outline" })}
      >
        <ExternalLink aria-hidden />
        PDF&apos;i aç
      </a>
    </div>
  );
}
