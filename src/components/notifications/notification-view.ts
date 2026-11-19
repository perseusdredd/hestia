import {
  AtSign,
  Bell,
  BellRing,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  CheckSquare,
  MessageCircle,
  MessageSquare,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

import type { NotificationDTO } from "@/server/notifications";

/** Serializable notification for client components. */
export type NotificationView = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  /** Workspace-relative, already validated by the service. */
  path: string;
  read: boolean;
  createdAt: string;
  actor: { name: string | null; email: string; image: string | null } | null;
};

export function toNotificationView(n: NotificationDTO): NotificationView {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    path: n.path,
    read: n.readAt !== null,
    createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : String(n.createdAt),
    actor: n.actor ? { name: n.actor.name, email: n.actor.email, image: n.actor.image } : null,
  };
}

const ICONS: Record<string, LucideIcon> = {
  TODO_ASSIGNED: CheckSquare,
  POST_CREATED: MessageSquare,
  POST_COMMENT: MessageCircle,
  COMMENT: MessageCircle,
  MENTION: AtSign,
  EVENT_CREATED: CalendarDays,
  MEMBER_JOINED: UserPlus,
  CHAT_DM: MessageSquare,
  CHECKIN: CalendarClock,
  EVENT_INVITE: CalendarPlus,
  REMINDER: BellRing,
};

export function notificationIcon(type: string): LucideIcon {
  return ICONS[type] ?? Bell;
}

export function formatUnread(count: number): string {
  return count > 99 ? "99+" : String(count);
}
