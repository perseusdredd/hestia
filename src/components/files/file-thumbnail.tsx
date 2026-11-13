"use client";

import { useState } from "react";
import Image from "next/image";

import { inlineHref } from "@/app/w/[slug]/files/paths";

import { ItemIcon } from "./file-meta";

/**
 * 36x36 thumbnail for an allow-listed raster image (the caller checks
 * thumbnailEligible). Loaded lazily from the inline endpoint, which sniffs
 * the bytes again; if it refuses or fails, the type icon is shown instead.
 */
export function FileThumbnail({ fileId, name, mimeType }: { fileId: string; name: string; mimeType: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ItemIcon kind="file" mimeType={mimeType} name={name} />;
  return (
    <span className="flex size-9 shrink-0 overflow-hidden rounded-lg bg-muted ring-1 ring-border">
      <Image
        src={inlineHref(fileId)}
        alt=""
        width={36}
        height={36}
        unoptimized
        loading="lazy"
        decoding="async"
        draggable={false}
        className="size-9 object-cover"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
