import {
  Activity,
  CalendarCheck,
  CalendarPlus,
  CheckCircle2,
  FilePen,
  FilePlus,
  FileUp,
  FolderPlus,
  ListPlus,
  ListTodo,
  MessageCircle,
  MessageSquare,
  RotateCcw,
  Undo2,
  UserCog,
  UserMinus,
  UserPlus,
  UserX,
  type LucideIcon,
} from "lucide-react";

import type { ActivityDTO, ActivityGroup } from "@/server/activity";

/** Serializable activity row for client components. */
export type ActivityView = {
  id: string;
  type: string;
  title: string;
  /** Workspace-relative, already validated by the service (null: no link). */
  path: string | null;
  createdAt: string;
  actor: { name: string | null; email: string; image: string | null } | null;
};

export function toActivityView(a: ActivityDTO): ActivityView {
  return {
    id: a.id,
    type: a.type,
    title: a.title,
    path: a.path,
    createdAt: a.createdAt instanceof Date ? a.createdAt.toISOString() : String(a.createdAt),
    actor: a.actor ? { name: a.actor.name, email: a.actor.email, image: a.actor.image } : null,
  };
}

/** Feed URL with optional type-group and member filters. */
export function activityHref(slug: string, group: string | null, actorId: string | null): string {
  const qs = new URLSearchParams();
  if (group) qs.set("type", group);
  if (actorId) qs.set("actor", actorId);
  const s = qs.toString();
  return `/w/${slug}/activity${s ? `?${s}` : ""}`;
}

/** Shown when the actor's account was deleted (the row keeps actorId = null). */
export const DELETED_USER_LABEL = "Silinmiş kullanıcı";

export const ACTIVITY_GROUP_LABELS: Record<ActivityGroup, string> = {
  messages: "Mesajlar",
  todos: "Yapılacaklar",
  calendar: "Takvim",
  files: "Dosyalar",
  trash: "Çöp kutusu",
  members: "Üyeler",
};

/**
 * Sentence parts: "<actor> <before><subject><after>". `subject: false` hides
 * the stored title (it repeats the actor's own name).
 */
type Meta = { icon: LucideIcon; before: string; after?: string; subject?: boolean };

const META: Record<string, Meta> = {
  POST_CREATED: { icon: MessageSquare, before: "bir mesaj paylaştı: " },
  COMMENT_CREATED: { icon: MessageCircle, before: "", after: " mesajına yorum yaptı" },
  TODO_LIST_CREATED: { icon: ListPlus, before: "yeni bir yapılacaklar listesi oluşturdu: " },
  TODO_CREATED: { icon: ListTodo, before: "bir görev ekledi: " },
  TODO_COMPLETED: { icon: CheckCircle2, before: "bir görevi tamamladı: " },
  TODO_REOPENED: { icon: RotateCcw, before: "bir görevi yeniden açtı: " },
  HILL_UPDATED: { icon: Activity, before: "bir listenin tepe grafiğini güncelledi: " },
  EVENT_CREATED: { icon: CalendarPlus, before: "bir etkinlik ekledi: " },
  EVENT_UPDATED: { icon: CalendarCheck, before: "bir etkinliği güncelledi: " },
  FILE_UPLOADED: { icon: FileUp, before: "bir dosya yükledi: " },
  DOCUMENT_CREATED: { icon: FilePlus, before: "bir doküman oluşturdu: " },
  DOCUMENT_UPDATED: { icon: FilePen, before: "bir dokümanı güncelledi: " },
  FOLDER_CREATED: { icon: FolderPlus, before: "bir klasör oluşturdu: " },
  ITEM_RESTORED: { icon: Undo2, before: "çöp kutusundan geri yükledi: " },
  MEMBER_JOINED: { icon: UserPlus, before: "çalışma alanına katıldı", subject: false },
  MEMBER_LEFT: { icon: UserMinus, before: "çalışma alanından ayrıldı", subject: false },
  MEMBER_REMOVED: { icon: UserX, before: "bir üyeyi çalışma alanından çıkardı: " },
  MEMBER_ROLE_CHANGED: { icon: UserCog, before: "bir üyenin rolünü değiştirdi: " },
};

const FALLBACK: Meta = { icon: Activity, before: "bir değişiklik yaptı: " };

export function activityMeta(type: string): Required<Meta> {
  const m = META[type] ?? FALLBACK;
  return { icon: m.icon, before: m.before, after: m.after ?? "", subject: m.subject ?? true };
}

/** Whether the subject is quoted (it sits inside the sentence, not after a colon). */
export function quotesSubject(type: string): boolean {
  return type === "COMMENT_CREATED";
}
