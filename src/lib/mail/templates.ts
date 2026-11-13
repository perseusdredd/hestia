import { formatDateTime } from "@/lib/format";

import { escapeHtml, headerText } from "./escape";

/*
 * Plain Turkish emails: a text part plus a simple inline-styled HTML part.
 * No remote images, no scripts. Every user-supplied string goes through
 * escapeHtml() in the HTML part and headerText() when it reaches the subject.
 */

export type MailContent = { subject: string; text: string; html: string };

const FOOTER_TEXT = "Bu e-posta Hestia tarafından otomatik olarak gönderildi.";

function layout(opts: { heading: string; paragraphs: string[]; link: string; button: string; after?: string[] }) {
  const p = (html: string) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1f2937">${html}</p>`;
  const link = escapeHtml(opts.link);
  return [
    "<!doctype html>",
    '<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(opts.heading)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">',
    '<tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px">',
    "<tr><td>",
    '<p style="margin:0 0 20px;font-size:18px;font-weight:bold;color:#111827">Hestia</p>',
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827">${escapeHtml(opts.heading)}</h1>`,
    ...opts.paragraphs.map(p),
    `<p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;padding:12px 20px;border-radius:8px">${escapeHtml(opts.button)}</a></p>`,
    p(`Düğme çalışmazsa bu bağlantıyı tarayıcınıza yapıştırın:<br><span style="word-break:break-all;color:#374151">${link}</span>`),
    ...(opts.after ?? []).map(p),
    `<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6b7280">${escapeHtml(FOOTER_TEXT)}</p>`,
    "</td></tr></table>",
    "</td></tr></table>",
    "</body></html>",
  ].join("");
}

function text(lines: string[]): string {
  return [...lines, "", "--", FOOTER_TEXT].join("\n");
}

/** Single-line version of a user-supplied value for the text part. */
function plain(value: string): string {
  return headerText(value, 200);
}

export function inviteEmail(opts: {
  workspaceName: string;
  inviterName: string;
  roleLabel: string;
  link: string;
  expiresAt: Date;
}): MailContent {
  const ws = plain(opts.workspaceName);
  const inviter = plain(opts.inviterName);
  const expires = formatDateTime(opts.expiresAt);
  return {
    subject: `${headerText(opts.inviterName, 60)} sizi ${headerText(opts.workspaceName, 60)} çalışma alanına davet etti`,
    text: text([
      "Merhaba,",
      "",
      `${inviter}, sizi Hestia'daki "${ws}" çalışma alanına ${opts.roleLabel} olarak davet etti.`,
      "",
      "Daveti kabul etmek için bağlantıyı açın:",
      opts.link,
      "",
      `Bu davet ${expires} (İstanbul saati) tarihine kadar geçerlidir ve yalnızca bir kez kullanılabilir.`,
      "Bu daveti beklemiyorsanız e-postayı yok sayabilirsiniz.",
    ]),
    html: layout({
      heading: "Çalışma alanı daveti",
      paragraphs: [
        "Merhaba,",
        `<strong>${escapeHtml(inviter)}</strong>, sizi Hestia'daki <strong>${escapeHtml(ws)}</strong> çalışma alanına ${escapeHtml(opts.roleLabel)} olarak davet etti.`,
      ],
      link: opts.link,
      button: "Daveti görüntüle",
      after: [
        `Bu davet <strong>${escapeHtml(expires)}</strong> (İstanbul saati) tarihine kadar geçerlidir ve yalnızca bir kez kullanılabilir.`,
        "Bu daveti beklemiyorsanız e-postayı yok sayabilirsiniz.",
      ],
    }),
  };
}

export function verifyEmailMail(opts: { name: string | null; link: string }): MailContent {
  const hello = opts.name ? `Merhaba ${plain(opts.name)},` : "Merhaba,";
  return {
    subject: "E-posta adresinizi doğrulayın",
    text: text([
      hello,
      "",
      "Hestia hesabınızın e-posta adresini doğrulamak için bağlantıyı açın:",
      opts.link,
      "",
      "Bağlantı 24 saat geçerlidir ve yalnızca bir kez kullanılabilir.",
      "Bu hesabı siz oluşturmadıysanız e-postayı yok sayabilirsiniz.",
    ]),
    html: layout({
      heading: "E-posta adresinizi doğrulayın",
      paragraphs: [
        escapeHtml(hello),
        "Hestia hesabınızın e-posta adresini doğrulamak için aşağıdaki düğmeyi kullanın.",
      ],
      link: opts.link,
      button: "E-postamı doğrula",
      after: [
        "Bağlantı 24 saat geçerlidir ve yalnızca bir kez kullanılabilir.",
        "Bu hesabı siz oluşturmadıysanız e-postayı yok sayabilirsiniz.",
      ],
    }),
  };
}

export function passwordResetMail(opts: { name: string | null; link: string }): MailContent {
  const hello = opts.name ? `Merhaba ${plain(opts.name)},` : "Merhaba,";
  return {
    subject: "Şifre sıfırlama isteği",
    text: text([
      hello,
      "",
      "Hestia hesabınız için şifre sıfırlama isteği aldık. Yeni bir şifre belirlemek için bağlantıyı açın:",
      opts.link,
      "",
      "Bağlantı 1 saat geçerlidir ve yalnızca bir kez kullanılabilir.",
      "Bu isteği siz yapmadıysanız e-postayı yok sayın; şifreniz değişmez.",
    ]),
    html: layout({
      heading: "Şifre sıfırlama",
      paragraphs: [
        escapeHtml(hello),
        "Hestia hesabınız için şifre sıfırlama isteği aldık. Yeni bir şifre belirlemek için aşağıdaki düğmeyi kullanın.",
      ],
      link: opts.link,
      button: "Yeni şifre belirle",
      after: [
        "Bağlantı 1 saat geçerlidir ve yalnızca bir kez kullanılabilir.",
        "Bu isteği siz yapmadıysanız e-postayı yok sayın; şifreniz değişmez.",
      ],
    }),
  };
}
