import { randomBytes } from "node:crypto";

/** Max upload size, enforced server-side (create, local PUT and complete). */
export const MAX_FILE_SIZE = 25 * 1024 * 1024;

/** Allowed characters in a storage key segment. No slashes, no "..". */
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/**
 * Turn a user-supplied file name into a safe ASCII key segment.
 * Strips directories, diacritics and anything outside [A-Za-z0-9._-].
 */
export function sanitizeKeySegment(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const ascii = base
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/İ/g, "I");
  let cleaned = ascii
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  if (cleaned.length > 100) {
    const dot = cleaned.lastIndexOf(".");
    const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
    cleaned = cleaned.slice(0, 100 - ext.length).replace(/[.-]+$/, "") + ext;
  }
  return cleaned || "dosya";
}

/** Server-generated storage key: "<workspaceId>/<random id>/<sanitised name>". */
export function generateStorageKey(workspaceId: string, fileName: string): string {
  if (!SEGMENT_RE.test(workspaceId) || workspaceId.includes(".")) {
    throw new Error("Invalid workspace id for storage key");
  }
  const id = randomBytes(16).toString("hex");
  return `${workspaceId}/${id}/${sanitizeKeySegment(fileName)}`;
}

/** True when `key` has exactly the shape generateStorageKey() produces. */
export function isValidStorageKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > 400) return false;
  const parts = key.split("/");
  if (parts.length !== 3) return false;
  return parts.every((p) => SEGMENT_RE.test(p) && p !== "." && p !== ".." && !p.includes(".."));
}

/** True when `workspaceId` can be the first segment of a storage key (prefix deletes rely on it). */
export function isValidWorkspaceSegment(workspaceId: string): boolean {
  return typeof workspaceId === "string" && SEGMENT_RE.test(workspaceId) && !workspaceId.includes(".");
}

/** True when the key belongs to `workspaceId` (prefix check on a valid key). */
export function keyBelongsToWorkspace(key: string, workspaceId: string): boolean {
  return isValidStorageKey(key) && key.split("/")[0] === workspaceId;
}

/** Content-Disposition value with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function contentDisposition(fileName: string, type: "attachment" | "inline" = "attachment"): string {
  const clean = fileName.replace(/[\u0000-\u001f\u007f"\\]/g, "").trim() || "dosya";
  const ascii = sanitizeKeySegment(clean);
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** MIME types we let the browser see as-is on download (still as attachment). */
const PASSTHROUGH_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/zip",
]);

/** Content-Type to serve a stored file with. Never text/html or image/svg+xml. */
export function downloadContentType(mimeType: string): string {
  return PASSTHROUGH_TYPES.has(mimeType) ? mimeType : "application/octet-stream";
}

/** Normalise a client-reported MIME type (falls back to octet-stream). */
export function normalizeMimeType(type: string | undefined | null): string {
  const t = (type ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(t)
    ? t
    : "application/octet-stream";
}
