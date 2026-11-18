import type { NotificationType } from "@/server/notifications";

/** Turkish labels for the toggleable notification types (settings page). */
export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  TODO_ASSIGNED: "Bana görev atandığında",
  POST_CREATED: "Yeni mesaj paylaşıldığında",
  POST_COMMENT: "Mesajlara yorum yapıldığında",
  COMMENT: "Görev, doküman ve etkinliklere yorum yapıldığında",
  MENTION: "Biri beni andığında (@)",
  EVENT_CREATED: "Yeni etkinlik eklendiğinde",
  MEMBER_JOINED: "Yeni üye katıldığında (yöneticiler)",
  CHAT_DM: "Doğrudan mesaj geldiğinde",
  CHECKIN: "Otomatik kontrol sorusu sorulduğunda",
};
