import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { escapeHtml, headerText, MailHeaderError } from "@/lib/mail/escape";
import { getAppOrigin, MailOriginError } from "@/lib/mail/origin";
import { inviteEmail } from "@/lib/mail/templates";
import { DEV_OUTBOX_TAKE, devOutboxEnabled, listOwnOutbox, queueMail, sendMail } from "@/server/mail";
import { acceptInvitation, createInvitation } from "@/server/workspaces";

import { addMember, cleanup, createTestUser, createTestWorkspace, uniqueSuffix } from "./helpers";

const recipients = new Set<string>();

function address(): string {
  const email = `mail-${uniqueSuffix()}@hestia.test`;
  recipients.add(email);
  return email;
}

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await db.emailOutbox.deleteMany({ where: { to: { in: [...recipients] } } });
  await cleanup();
});

describe("sendMail", () => {
  it("writes an outbox row and stops there with the default outbox driver", async () => {
    vi.stubEnv("MAIL_DRIVER", "");
    const to = address();
    const result = await sendMail({ to, subject: "Konu", text: "Merhaba", html: "<p>Merhaba</p>", kind: "invite" });
    expect(result.status).toBe("queued");
    const row = await db.emailOutbox.findUniqueOrThrow({ where: { id: result.id } });
    expect(row).toMatchObject({ to, subject: "Konu", text: "Merhaba", kind: "invite", sentAt: null, error: null });
  });

  it("records the SMTP error on the row instead of throwing", async () => {
    vi.stubEnv("MAIL_DRIVER", "smtp");
    vi.stubEnv("SMTP_HOST", "127.0.0.1");
    vi.stubEnv("SMTP_PORT", "1"); // nothing listens here: connection refused
    const to = address();
    const result = await sendMail({ to, subject: "Konu", text: "Merhaba", kind: "verify-email" });
    expect(result.status).toBe("failed");
    const row = await db.emailOutbox.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.sentAt).toBeNull();
    expect(row.error).toBeTruthy();
  });

  it("rejects CR/LF (header injection) in recipient and subject, writing nothing", async () => {
    const to = address();
    for (const bad of [
      { to: `${to}\r\nBcc: victim@hestia.test`, subject: "Konu" },
      { to, subject: "Konu\r\nBcc: victim@hestia.test" },
      { to, subject: "Konu\nX-Injected: 1" },
      { to, subject: "Konu X-Injected: 1" },
    ]) {
      await expect(queueMail({ ...bad, text: "x", kind: "invite" })).rejects.toBeInstanceOf(MailHeaderError);
    }
    expect(await db.emailOutbox.count({ where: { to } })).toBe(0);
  });

  it("rejects an invalid MAIL_FROM with a line break", async () => {
    vi.stubEnv("MAIL_DRIVER", "smtp");
    vi.stubEnv("SMTP_HOST", "127.0.0.1");
    vi.stubEnv("SMTP_PORT", "1");
    vi.stubEnv("MAIL_FROM", "Hestia <a@hestia.test>\r\nBcc: x@hestia.test");
    const result = await sendMail({ to: address(), subject: "Konu", text: "x", kind: "invite" });
    expect(result.status).toBe("failed");
    const row = await db.emailOutbox.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.error).toMatch(/from/);
  });
});

describe("escaping helpers", () => {
  it("escapes HTML and flattens header text", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(headerText("Ali\r\nBcc: x@y.z\tVeli")).toBe("Ali Bcc: x@y.z Veli");
    expect(headerText("x".repeat(100), 10)).toHaveLength(10);
  });

  it("templates never emit user markup unescaped", () => {
    const mail = inviteEmail({
      workspaceName: `<img src=x onerror=alert(1)>`,
      inviterName: `"><script>alert(1)</script>`,
      roleLabel: "üye",
      link: "https://hestia.example/invite/abc",
      expiresAt: new Date("2026-01-01T09:00:00Z"),
    });
    expect(mail.html).not.toMatch(/<script|<img/);
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
});

describe("trusted link origin", () => {
  it("comes from AUTH_URL (path and query stripped), not from request headers", () => {
    vi.stubEnv("AUTH_URL", "https://app.hestia.example/api/auth?x=1");
    expect(getAppOrigin()).toBe("https://app.hestia.example");
  });

  it("refuses to guess in production without AUTH_URL", () => {
    vi.stubEnv("AUTH_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getAppOrigin()).toThrow(MailOriginError);
  });
});

describe("invitation email", () => {
  it("mails the link with inviter, workspace and expiry, HTML-escaped", async () => {
    vi.stubEnv("AUTH_URL", "https://hestia.example");
    const owner = await createTestUser({ name: `Ayşe <b>"Yönetici"</b>` });
    const { ctx } = await createTestWorkspace(owner.id, { name: `Ekip <script>alert(1)</script>` });
    const to = address();
    const { token, invitation, deliverEmail } = await createInvitation(ctx, { email: to, role: "MEMBER" });
    expect(await deliverEmail()).toBe("queued");

    const row = await db.emailOutbox.findFirstOrThrow({ where: { to, kind: "invite" } });
    const link = `https://hestia.example/invite/${token}`;
    expect(row.text).toContain(link);
    expect(row.html).toContain(link);
    expect(row.text).toContain("Ekip <script>alert(1)</script>"); // text part is plain text
    expect(row.text).toMatch(/tarihine kadar geçerlidir/);
    expect(row.html).not.toContain("<script>");
    expect(row.html).not.toContain("<b>");
    expect(row.html).toContain("Ekip &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(row.html).toContain("Ayşe &lt;b&gt;&quot;Yönetici&quot;&lt;/b&gt;");
    expect(row.subject).not.toMatch(/[\r\n]/);
    expect(row.subject).toContain("çalışma alanına davet etti");
    expect(invitation.email).toBe(to);
  });

  it("a failing mail never fails the invite", async () => {
    vi.stubEnv("MAIL_DRIVER", "smtp");
    vi.stubEnv("SMTP_HOST", "127.0.0.1");
    vi.stubEnv("SMTP_PORT", "1");
    const owner = await createTestUser();
    const { ctx } = await createTestWorkspace(owner.id);
    const to = address();
    const { invitation, deliverEmail } = await createInvitation(ctx, { email: to, role: "MEMBER" });
    expect(await deliverEmail()).toBe("failed");
    expect(await db.invitation.findUnique({ where: { id: invitation.id } })).not.toBeNull();
  });

  it("accepting an invite never verifies the address (the inviter holds the token)", async () => {
    const owner = await createTestUser();
    const { ctx } = await createTestWorkspace(owner.id);
    const to = address();
    const invitee = await createTestUser({ email: to });
    expect(invitee.emailVerified).toBeNull();
    const { token } = await createInvitation(ctx, { email: to, role: "MEMBER" });
    await acceptInvitation({ userId: invitee.id, email: invitee.email }, token);
    const after = await db.user.findUniqueOrThrow({ where: { id: invitee.id } });
    expect(after.emailVerified).toBeNull();


    // Already-member branch (a pending invite consumed after joining another way)
    // must not verify either.
    const other = await createTestWorkspace(owner.id);
    const member = await createTestUser({ email: address() });
    const { token: pending } = await createInvitation(other.ctx, { email: member.email, role: "MEMBER" });
    await addMember(other.workspace.id, member.id);
    const res = await acceptInvitation({ userId: member.id, email: member.email }, pending);
    expect(res.alreadyMember).toBe(true);
    const memberRow = await db.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(memberRow.emailVerified).toBeNull();
  });
});

describe("dev outbox", () => {
  it("is on outside production and in production only with ENABLE_DEV_OUTBOX=true", () => {
    expect(devOutboxEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(devOutboxEnabled({ NODE_ENV: "test" })).toBe(true);
    expect(devOutboxEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(devOutboxEnabled({ NODE_ENV: "production", ENABLE_DEV_OUTBOX: "1" })).toBe(false);
    expect(devOutboxEnabled({ NODE_ENV: "production", ENABLE_DEV_OUTBOX: "yes" })).toBe(false);
    expect(devOutboxEnabled({ NODE_ENV: "production", ENABLE_DEV_OUTBOX: "true" })).toBe(true);
  });

  it("lists only mail addressed to the user's own email, newest first", async () => {
    const me = await createTestUser({ email: address() });
    const other = await createTestUser({ email: address() });
    await sendMail({ to: me.email, subject: "Birinci", text: "1", kind: "verify-email" });
    await sendMail({ to: other.email, subject: "Başkasının", text: "gizli", kind: "password-reset" });
    // Upper-case recipient is normalised by the mailer and still mine.
    await sendMail({ to: me.email.toUpperCase(), subject: "İkinci", text: "2", kind: "invite" });

    const mine = await listOwnOutbox(me.id);
    expect(mine.map((m) => m.subject)).toEqual(["İkinci", "Birinci"]);
    expect(mine.every((m) => m.to === me.email)).toBe(true);

    const theirs = await listOwnOutbox(other.id);
    expect(theirs.map((m) => m.subject)).toEqual(["Başkasının"]);
  });

  it("returns nothing for an unknown user id and caps take", async () => {
    expect(await listOwnOutbox("does-not-exist")).toEqual([]);
    const me = await createTestUser({ email: address() });
    await expect(listOwnOutbox(me.id, { take: DEV_OUTBOX_TAKE + 1 })).rejects.toThrow();
    await expect(listOwnOutbox("")).rejects.toThrow();
  });
});
