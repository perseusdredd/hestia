import { z } from "zod";

/** bcrypt only hashes the first 72 bytes of its input; longer passwords would be silently truncated. */
export const BCRYPT_MAX_BYTES = 72;

/** New passwords (registration). Login keeps accepting the old 200-char limit. */
export const newPasswordField = z
  .string()
  .min(8, "Şifre en az 8 karakter olmalı.")
  .max(200, "Şifre çok uzun.")
  .refine((p) => Buffer.byteLength(p, "utf8") <= BCRYPT_MAX_BYTES, {
    message: `Şifre en fazla ${BCRYPT_MAX_BYTES} bayt olabilir (Türkçe karakterler 2 bayt sayılır).`,
  });
