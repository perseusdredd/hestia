import { z } from "zod";

import { db } from "@/lib/db";
import { assertHeaderSafe } from "@/lib/mail/escape";
import { mailDriver, mailFrom, smtpTransport } from "@/lib/mail/transport";
import { parseInput } from "@/server/errors";

/*
 * Mailer. Every mail is written to EmailOutbox FIRST (the durable record and,
 * with MAIL_DRIVER=outbox, the only effect). With MAIL_DRIVER=smtp the row is
 * then delivered through nodemailer and gets sentAt or error.
 *
 * queueMail() returns a `deliver` thunk so callers that must not leak timing
 * (forgot-password) can run delivery after the response (next/server after()).
 * deliver() never throws: transport failures end up in the row's `error`.
 */

export type MailKind = "invite" | "verify-email" | "password-reset";
export type MailStatus = "queued" | "sent" | "failed";

export type MailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind: MailKind;
};

export type QueuedMail = { id: string; deliver: () => Promise<MailStatus> };

const mailSchema = z.object({
  to: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  subject: z.string().min(1).max(200),
  text: z.string().min(1).max(100_000),
  html: z.string().max(200_000).optional(),
  kind: z.enum(["invite", "verify-email", "password-reset"]),
});

/** Writes the outbox row; throws on invalid input (e.g. CR/LF in a header value). */
export async function queueMail(input: MailInput): Promise<QueuedMail> {
  // Header-injection guard runs on the raw values, before any trimming.
  assertHeaderSafe("to", String(input.to ?? ""));
  assertHeaderSafe("subject", String(input.subject ?? ""));
  const data = parseInput(mailSchema, input);

  const row = await db.emailOutbox.create({
    data: { to: data.to, subject: data.subject, text: data.text, html: data.html ?? null, kind: data.kind },
    select: { id: true },
  });

  let pending: Promise<MailStatus> | null = null;
  const deliver = () => (pending ??= deliverRow(row.id, data));
  return { id: row.id, deliver };
}

/** queueMail + immediate delivery. Throws only for invalid input, never for transport errors. */
export async function sendMail(input: MailInput): Promise<{ id: string; status: MailStatus }> {
  const queued = await queueMail(input);
  return { id: queued.id, status: await queued.deliver() };
}

async function deliverRow(id: string, data: z.output<typeof mailSchema>): Promise<MailStatus> {
  if (mailDriver() !== "smtp") return "queued";
  try {
    await smtpTransport().sendMail({
      from: mailFrom(),
      to: data.to,
      subject: data.subject,
      text: data.text,
      html: data.html,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    await db.emailOutbox.update({ where: { id }, data: { sentAt: new Date(), error: null } }).catch(() => undefined);
    return "sent";
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    console.error(`[mail] delivery of outbox row ${id} failed: ${message}`);
    await db.emailOutbox.update({ where: { id }, data: { error: message } }).catch(() => undefined);
    return "failed";
  }
}

// ------------------------------------------------------- dev outbox ----

/**
 * /dev/outbox is on outside production, or in production only with
 * ENABLE_DEV_OUTBOX=true (e.g. a local `next start` used for smoke/e2e).
 */
export function devOutboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" || env.ENABLE_DEV_OUTBOX?.trim() === "true";
}

export const DEV_OUTBOX_TAKE = 50;

export type OutboxMailDTO = {
  id: string;
  to: string;
  subject: string;
  text: string;
  kind: string;
  sentAt: Date | null;
  error: string | null;
  createdAt: Date;
};

/**
 * Documented exception to the ctx-first rule (mail belongs to a user, not a
 * workspace): the newest outbox rows addressed to `userId`'s OWN email. The
 * address is read from the DB, never taken from the caller, so a user can
 * only ever see mail sent to themselves.
 */
export async function listOwnOutbox(
  userId: string,
  opts: { take?: number } = {},
): Promise<OutboxMailDTO[]> {
  const { id, take } = parseInput(
    z.object({ id: z.string().min(1).max(64), take: z.number().int().min(1).max(DEV_OUTBOX_TAKE).optional() }),
    { id: userId, take: opts.take },
  );
  const user = await db.user.findUnique({ where: { id }, select: { email: true } });
  if (!user) return [];
  return db.emailOutbox.findMany({
    where: { to: user.email.toLowerCase() },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take ?? DEV_OUTBOX_TAKE,
    select: { id: true, to: true, subject: true, text: true, kind: true, sentAt: true, error: true, createdAt: true },
  });
}
