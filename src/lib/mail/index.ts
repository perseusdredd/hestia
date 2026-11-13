export { assertHeaderSafe, escapeHtml, hasHeaderBreak, headerText, MailHeaderError } from "./escape";
export { appLink, getAppOrigin, MailOriginError } from "./origin";
export { inviteEmail, passwordResetMail, verifyEmailMail, type MailContent } from "./templates";
export { mailDriver, mailFrom, smtpTransport, type MailDriver } from "./transport";
