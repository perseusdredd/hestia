import {
  CalendarDays,
  CheckSquare,
  FileText,
  Folder,
  ListTodo,
  MessageCircle,
  MessageSquare,
  NotebookText,
  type LucideIcon,
} from "lucide-react";

import type { SearchType } from "@/server/search";

export const SEARCH_TYPE_META: Record<SearchType, { label: string; icon: LucideIcon }> = {
  post: { label: "Mesajlar", icon: MessageSquare },
  comment: { label: "Yorumlar", icon: MessageCircle },
  todo: { label: "Yapılacaklar", icon: CheckSquare },
  list: { label: "Listeler", icon: ListTodo },
  document: { label: "Dokümanlar", icon: NotebookText },
  file: { label: "Dosyalar", icon: FileText },
  folder: { label: "Klasörler", icon: Folder },
  event: { label: "Etkinlikler", icon: CalendarDays },
};

/** Builds /w/[slug]/search?q=...&type=... */
export function searchHref(slug: string, q: string, type?: SearchType | null): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (type) params.set("type", type);
  const qs = params.toString();
  return qs ? `/w/${slug}/search?${qs}` : `/w/${slug}/search`;
}
