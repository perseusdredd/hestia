// Pure helpers - safe for client and server.

const TR_MAP: Record<string, string> = {
  ç: "c", Ç: "c", ğ: "g", Ğ: "g", ı: "i", I: "i", İ: "i",
  ö: "o", Ö: "o", ş: "s", Ş: "s", ü: "u", Ü: "u",
};

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "auth", "billing", "dashboard", "help", "hestia",
  "invite", "invites", "login", "logout", "new", "onboarding", "register",
  "settings", "signin", "signout", "signup", "static", "support", "w", "www",
  "_next", "public", "assets", "account", "workspace", "workspaces",
]);

/** "Ayşe'nin Ajansı" -> "aysenin-ajansi" */
export function slugify(input: string): string {
  return input
    .replace(/[çÇğĞıIİöÖşŞüÜ]/g, (ch) => TR_MAP[ch] ?? ch)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}
