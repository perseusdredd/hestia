import { contentDisposition } from "./keys";

/*
 * Inline (in-browser) serving rules. Downloads are always `attachment`; only
 * the types below may ever be shown inline, and only when the stored bytes
 * start with the matching magic number. The stored MIME string comes from the
 * client and is never echoed: the response always carries the canonical type
 * from this table. SVG, HTML, XML and anything scriptable are absent on
 * purpose. Text types are never served inline by the endpoint; the preview
 * page reads them on the server and renders them as escaped text.
 */

export type InlineKind = "image" | "pdf" | "audio" | "video";
export type PreviewKind = InlineKind | "text";

/** Bytes read from the start of an object to verify its magic number. */
export const SNIFF_BYTES = 64;
/** Text previews read at most this many bytes. */
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
/** List thumbnails are only requested for images up to this size. */
export const THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;

type Sniffer = (b: Uint8Array) => boolean;

const startsWith = (b: Uint8Array, sig: number[], offset = 0) =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

const isPng: Sniffer = (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isJpeg: Sniffer = (b) => startsWith(b, [0xff, 0xd8, 0xff]);
const isGif: Sniffer = (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"));
const isRiff = (b: Uint8Array, form: string) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii(form), 8);
const isWebp: Sniffer = (b) => isRiff(b, "WEBP");
const isWav: Sniffer = (b) => isRiff(b, "WAVE");
const isPdf: Sniffer = (b) => startsWith(b, ascii("%PDF-"));
const isOgg: Sniffer = (b) => startsWith(b, ascii("OggS"));
const isEbml: Sniffer = (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]); // WebM / Matroska
const isFlac: Sniffer = (b) => startsWith(b, ascii("fLaC"));
/** MP3: ID3v2 tag or an MPEG audio frame sync (11 set bits, layer != 0). */
const isMp3: Sniffer = (b) =>
  startsWith(b, ascii("ID3")) || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0);

/** ISO-BMFF ("....ftyp<brand>"): brands from the major brand and the compatible list. */
function ftypBrands(b: Uint8Array): string[] | null {
  if (!startsWith(b, ascii("ftyp"), 4)) return null;
  const boxSize = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  if (boxSize < 16) return null;
  const end = Math.min(boxSize, b.length);
  const brands: string[] = [];
  const read = (at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
  if (end >= 12) brands.push(read(8));
  for (let at = 16; at + 4 <= end; at += 4) brands.push(read(at));
  return brands;
}
const AVIF_BRANDS = new Set(["avif", "avis"]);
const isAvif: Sniffer = (b) => ftypBrands(b)?.some((x) => AVIF_BRANDS.has(x)) ?? false;
const isIsoMedia: Sniffer = (b) => {
  const brands = ftypBrands(b);
  // HEIF/AVIF stills are images, not media.
  return brands !== null && !brands.some((x) => AVIF_BRANDS.has(x) || x === "heic" || x === "mif1");
};

type InlineSpec = { kind: InlineKind; contentType: string; sniff: Sniffer };

const INLINE_TYPES: Record<string, InlineSpec> = {
  "image/png": { kind: "image", contentType: "image/png", sniff: isPng },
  "image/jpeg": { kind: "image", contentType: "image/jpeg", sniff: isJpeg },
  "image/jpg": { kind: "image", contentType: "image/jpeg", sniff: isJpeg },
  "image/pjpeg": { kind: "image", contentType: "image/jpeg", sniff: isJpeg },
  "image/gif": { kind: "image", contentType: "image/gif", sniff: isGif },
  "image/webp": { kind: "image", contentType: "image/webp", sniff: isWebp },
  "image/avif": { kind: "image", contentType: "image/avif", sniff: isAvif },
  "application/pdf": { kind: "pdf", contentType: "application/pdf", sniff: isPdf },
  "audio/mpeg": { kind: "audio", contentType: "audio/mpeg", sniff: isMp3 },
  "audio/mp3": { kind: "audio", contentType: "audio/mpeg", sniff: isMp3 },
  "audio/ogg": { kind: "audio", contentType: "audio/ogg", sniff: isOgg },
  "audio/wav": { kind: "audio", contentType: "audio/wav", sniff: isWav },
  "audio/wave": { kind: "audio", contentType: "audio/wav", sniff: isWav },
  "audio/x-wav": { kind: "audio", contentType: "audio/wav", sniff: isWav },
  "audio/webm": { kind: "audio", contentType: "audio/webm", sniff: isEbml },
  "audio/flac": { kind: "audio", contentType: "audio/flac", sniff: isFlac },
  "audio/x-flac": { kind: "audio", contentType: "audio/flac", sniff: isFlac },
  "audio/mp4": { kind: "audio", contentType: "audio/mp4", sniff: isIsoMedia },
  "audio/x-m4a": { kind: "audio", contentType: "audio/mp4", sniff: isIsoMedia },
  "video/mp4": { kind: "video", contentType: "video/mp4", sniff: isIsoMedia },
  "video/quicktime": { kind: "video", contentType: "video/quicktime", sniff: isIsoMedia },
  "video/webm": { kind: "video", contentType: "video/webm", sniff: isEbml },
  "video/ogg": { kind: "video", contentType: "video/ogg", sniff: isOgg },
};

/** Raster image types that may appear as list thumbnails. */
const THUMBNAIL_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Inline rule for a stored MIME type, or null (never inline). */
export function inlineSpec(mimeType: string): Omit<InlineSpec, "sniff"> | null {
  const spec = INLINE_TYPES[(mimeType ?? "").trim().toLowerCase()];
  return spec ? { kind: spec.kind, contentType: spec.contentType } : null;
}

/** Canonical Content-Type for inline serving, or null when the type is not allow-listed. */
export function inlineContentType(mimeType: string): string | null {
  return inlineSpec(mimeType)?.contentType ?? null;
}

/** True when the leading bytes are a real file of the allow-listed type `mimeType`. */
export function sniffMatches(mimeType: string, head: Uint8Array): boolean {
  const spec = INLINE_TYPES[(mimeType ?? "").trim().toLowerCase()];
  return spec ? spec.sniff(head) : false;
}

/** Whether the file list may show an <img> thumbnail (the endpoint still sniffs). */
export function thumbnailEligible(mimeType: string, size: number): boolean {
  const spec = inlineSpec(mimeType);
  return (
    spec !== null &&
    THUMBNAIL_TYPES.has(spec.contentType) &&
    Number.isFinite(size) &&
    size > 0 &&
    size <= THUMBNAIL_MAX_BYTES
  );
}

// ------------------------------------------------------------- text ----

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown", "text/csv", "application/json"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json", "log"]);

/**
 * Whether a file gets a server-rendered text preview. The text is rendered as
 * escaped text (never HTML), so an extension fallback is safe for files the
 * browser reported without a type.
 */
export function isTextPreviewable(mimeType: string, fileName: string): boolean {
  const t = (mimeType ?? "").trim().toLowerCase();
  if (TEXT_TYPES.has(t)) return true;
  if (t !== "application/octet-stream" && t !== "") return false;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && TEXT_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
}

/**
 * Decode at most `maxBytes` of UTF-8 for display. Returns null for binary
 * content (NUL bytes). `truncated` is true when the file is longer than the cap.
 */
export function decodeTextPreview(
  bytes: Uint8Array,
  totalSize: number,
  maxBytes = TEXT_PREVIEW_MAX_BYTES,
): { text: string; truncated: boolean } | null {
  const slice = bytes.subarray(0, maxBytes);
  if (slice.includes(0)) return null;
  const truncated = totalSize > slice.byteLength || bytes.byteLength > maxBytes;
  let text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(slice);
  // A multi-byte character cut at the cap decodes to U+FFFD; drop it.
  if (truncated) text = text.replace(/�+$/, "");
  return { text: text.replace(/\r\n?/g, "\n"), truncated };
}

// ---------------------------------------------------------- headers ----

/** Content-Disposition for inline display, same safe filename rules as downloads. */
export function inlineContentDisposition(fileName: string): string {
  return contentDisposition(fileName, "inline");
}

/** Per-kind CSP for the inline response: nothing but the resource itself, always sandboxed. */
export function inlineCsp(kind: InlineKind): string {
  const base = "default-src 'none'; base-uri 'none'; form-action 'none'; sandbox";
  switch (kind) {
    case "image":
      return `${base}; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'`;
    case "audio":
    case "video":
      return `${base}; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'`;
    case "pdf":
      // Embedded by the preview page in a same-origin <iframe> without a
      // sandbox attribute: Chromium's PDF viewer refuses sandboxed frames, but
      // works when the document sandboxes itself through this header.
      return `${base}; frame-ancestors 'self'`;
  }
}

/** Response headers for an inline body (200 or 206). */
export function inlineHeaders(kind: InlineKind, contentType: string, fileName: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Disposition": inlineContentDisposition(fileName),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": inlineCsp(kind),
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "private, max-age=300",
    "Referrer-Policy": "no-referrer",
    ...(kind === "audio" || kind === "video" ? { "Accept-Ranges": "bytes" } : {}),
  };
}

// ------------------------------------------------------------ range ----

export type ParsedRange =
  | { kind: "none" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

const POS = /^\d{1,15}$/;

/**
 * Parse a Range header for a body of `size` bytes (RFC 9110 single range).
 * - missing, non-"bytes" or syntactically invalid headers are ignored ("none": serve 200)
 * - multiple ranges are refused ("unsatisfiable": we never build multipart bodies)
 * - ranges starting past the end, "bytes=-0" and any range on an empty body are unsatisfiable
 * - the end is clamped to size - 1; "bytes=-N" is the last N bytes
 */
export function parseRange(header: string | null | undefined, size: number): ParsedRange {
  if (header === null || header === undefined) return { kind: "none" };
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m) return { kind: "none" };
  const specs = m[1].split(",").map((s) => s.trim());
  if (specs.some((s) => !/^(\d*)\s*-\s*(\d*)$/.test(s) || s.replace(/\s/g, "") === "-")) return { kind: "none" };
  if (specs.length !== 1) return { kind: "unsatisfiable" };

  const [rawStart, rawEnd] = specs[0].split("-").map((s) => s.trim());
  if ((rawStart && !POS.test(rawStart)) || (rawEnd && !POS.test(rawEnd))) return { kind: "none" };

  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (rawEnd && end < start) return { kind: "none" };
  if (start >= size) return { kind: "unsatisfiable" };
  return { kind: "range", start, end: Math.min(end, size - 1) };
}
