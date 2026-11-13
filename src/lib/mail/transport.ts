import nodemailer, { type Transporter } from "nodemailer";

import { assertHeaderSafe } from "./escape";

export type MailDriver = "outbox" | "smtp";

/** MAIL_DRIVER: "outbox" (default; only the EmailOutbox row) or "smtp". */
export function mailDriver(): MailDriver {
  return process.env.MAIL_DRIVER?.trim().toLowerCase() === "smtp" ? "smtp" : "outbox";
}

/** MAIL_FROM, e.g. "Hestia <no-reply@example.com>". */
export function mailFrom(): string {
  const from = process.env.MAIL_FROM?.trim() || "Hestia <no-reply@localhost>";
  assertHeaderSafe("from", from);
  return from;
}

let cached: { key: string; transporter: Transporter } | null = null;

/** Lazily created SMTP transport (recreated when the SMTP_* variables change). */
export function smtpTransport(): Transporter {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) throw new Error("SMTP_HOST is not set.");
  const port = Number(process.env.SMTP_PORT ?? 587) || 587;
  const user = process.env.SMTP_USER?.trim() || undefined;
  const pass = process.env.SMTP_PASS || undefined;
  const key = `${host}:${port}:${user ?? ""}:${pass ? "1" : "0"}`;
  if (cached?.key === key) return cached.transporter;
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  cached = { key, transporter };
  return transporter;
}
