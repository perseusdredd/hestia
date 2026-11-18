import {
  Activity,
  BarChart3,
  Bookmark,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  Columns3,
  FolderKanban,
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
  segment: "" | "my" | "reports" | "bookmarks" | "projects" | "messages" | "todos" | "files" | "calendar" | "cards" | "chat" | "checkins" | "activity" | "trash" | "settings";
  label: string;
  icon: LucideIcon;
  /** Hidden from guests (clients): chat, board, check-ins, reports, trash and settings are team-only. */
  teamOnly?: boolean;
};

/** Single source of truth for the workspace navigation. */
export const NAV_ITEMS: NavItem[] = [
  { segment: "", label: "Genel bakış", icon: House },
  { segment: "my", label: "Benim İşlerim", icon: UserRound },
  { segment: "reports", label: "Raporlar", icon: BarChart3, teamOnly: true },
  { segment: "bookmarks", label: "Yer imlerim", icon: Bookmark },
  { segment: "projects", label: "Projeler", icon: FolderKanban },
  { segment: "messages", label: "Mesajlar", icon: MessageSquare },
  { segment: "todos", label: "Yapılacaklar", icon: CheckSquare },
  { segment: "files", label: "Dosyalar", icon: FolderOpen },
  { segment: "calendar", label: "Takvim", icon: CalendarDays },
  { segment: "cards", label: "Pano", icon: Columns3, teamOnly: true },
  { segment: "chat", label: "Sohbet", icon: MessagesSquare, teamOnly: true },
  { segment: "checkins", label: "Otomatik kontroller", icon: CalendarClock, teamOnly: true },
  { segment: "activity", label: "Akış", icon: Activity },
  { segment: "trash", label: "Çöp kutusu", icon: Trash2, teamOnly: true },
  { segment: "settings", label: "Ayarlar", icon: Settings, teamOnly: true },
];

/** The navigation a member with this role sees (guests only get the non-team-only entries). */
export function navItemsFor(guest: boolean): NavItem[] {
  return guest ? NAV_ITEMS.filter((i) => !i.teamOnly) : NAV_ITEMS;
}

export function workspaceHref(slug: string, segment: NavItem["segment"] | string = ""): string {
  return segment ? `/w/${slug}/${segment}` : `/w/${slug}`;
}
