import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export function initials(name?: string | null, email?: string | null): string {
  const source = (name ?? "").trim() || (email ?? "").split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2);
  return letters.toLocaleUpperCase("tr");
}

/** Round avatar with image or initials fallback. */
export function UserAvatar({
  user,
  size = "default",
  className,
}: {
  user: { name?: string | null; email?: string | null; image?: string | null };
  size?: "sm" | "default" | "lg";
  className?: string;
}) {
  return (
    <Avatar size={size} className={className}>
      {user.image ? <AvatarImage src={user.image} alt="" /> : null}
      <AvatarFallback>{initials(user.name, user.email)}</AvatarFallback>
    </Avatar>
  );
}

/** Display name: name, else the local part of the email. */
export function displayName(user: { name?: string | null; email?: string | null }): string {
  return user.name?.trim() || user.email?.split("@")[0] || "Kullanıcı";
}
