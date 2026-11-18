import {
  Activity,
  BarChart3,
  Bookmark,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  Columns3,
  FolderOpen,
  House,
  UserRound,
  MessageSquare,
  MessagesSquare,
  Settings,
  Trash2,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  /** Path segment under /w/[slug]; "" is the overview. */
  segment: "" | "my" | "reports" | "bookmarks" | "messages" | "todos" | "files" | "calendar" | "cards" | "chat" | "checkins" | "activity" | "trash" | "settings";
  label: string;
  icon: LucideIcon;
};

/** Single source of truth for the workspace navigation. */
export const NAV_ITEMS: NavItem[] = [
  { segment: "", label: "Genel bakış", icon: House },
  { segment: "my", label: "Benim İşlerim", icon: UserRound },
  { segment: "reports", label: "Raporlar", icon: BarChart3 },
  { segment: "bookmarks", label: "Yer imlerim", icon: Bookmark },
  { segment: "messages", label: "Mesajlar", icon: MessageSquare },
  { segment: "todos", label: "Yapılacaklar", icon: CheckSquare },
  { segment: "files", label: "Dosyalar", icon: FolderOpen },
  { segment: "calendar", label: "Takvim", icon: CalendarDays },
  { segment: "cards", label: "Pano", icon: Columns3 },
  { segment: "chat", label: "Sohbet", icon: MessagesSquare },
  { segment: "checkins", label: "Otomatik kontroller", icon: CalendarClock },
  { segment: "activity", label: "Akış", icon: Activity },
  { segment: "trash", label: "Çöp kutusu", icon: Trash2 },
  { segment: "settings", label: "Ayarlar", icon: Settings },
];

export function workspaceHref(slug: string, segment: NavItem["segment"] | string = ""): string {
  return segment ? `/w/${slug}/${segment}` : `/w/${slug}`;
}
