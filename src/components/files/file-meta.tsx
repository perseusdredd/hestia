import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  NotebookText,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

/** "1,2 MB" style sizes with Turkish decimal commas. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const digits = value >= 100 ? 0 : 1;
  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: digits })} ${units[i]}`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "tgz"]);
const SHEET = new Set(["xls", "xlsx", "csv", "ods", "numbers"]);
const CODE = new Set(["js", "ts", "tsx", "jsx", "json", "html", "css", "xml", "py", "sql", "sh", "yml", "yaml"]);
const TEXT = new Set(["pdf", "doc", "docx", "txt", "md", "rtf", "odt", "pages", "ppt", "pptx", "key"]);

/** Icon + short Turkish label for a file, from MIME type and extension. */
export function fileKind(mimeType: string, name: string): { icon: LucideIcon; label: string } {
  const ext = extensionOf(name);
  if (mimeType.startsWith("image/")) return { icon: FileImage, label: "Görsel" };
  if (mimeType.startsWith("video/")) return { icon: FileVideo, label: "Video" };
  if (mimeType.startsWith("audio/")) return { icon: FileAudio, label: "Ses" };
  if (mimeType === "application/pdf" || ext === "pdf") return { icon: FileText, label: "PDF" };
  if (ARCHIVE.has(ext) || mimeType.includes("zip")) return { icon: FileArchive, label: "Arşiv" };
  if (SHEET.has(ext) || mimeType.includes("spreadsheet")) return { icon: FileSpreadsheet, label: "Tablo" };
  if (CODE.has(ext)) return { icon: FileCode, label: "Kod" };
  if (TEXT.has(ext) || mimeType.startsWith("text/")) return { icon: FileText, label: "Belge" };
  return { icon: FileIcon, label: ext ? ext.toUpperCase() : "Dosya" };
}

export function ItemIcon({
  kind,
  mimeType = "",
  name = "",
  className,
}: {
  kind: "folder" | "file" | "document";
  mimeType?: string;
  name?: string;
  className?: string;
}) {
  const Icon = kind === "folder" ? Folder : kind === "document" ? NotebookText : fileKind(mimeType, name).icon;
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg",
        kind === "folder"
          ? "bg-secondary text-foreground ring-1 ring-border"
          : kind === "document"
            ? "bg-secondary text-secondary-foreground"
            : "bg-muted text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-4.5" aria-hidden />
    </span>
  );
}
