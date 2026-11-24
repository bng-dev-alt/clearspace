import { emailConfig, isReservedRecipient, type EmailConfig } from './config';
import { buildMime, addressOnly } from './mime';
import { smtpSend, SmtpError } from './smtp';

export type SendOutcome =
  | { status: 'accepted'; transport: 'smtp'; messageId: string; attempts: number }
  | { status: 'failed'; transport: 'smtp'; errorCode: string; errorDetail: string; attempts: number }
  | { status: 'suppressed'; transport: 'none' | 'smtp'; errorCode: string; errorDetail: string; attempts: 0 };

export interface OutgoingEmail { to: string; subject: string; text: string; html: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strip anything that could be a credential or token before an error is stored or logged. */
export function sanitizeError(msg: string): string {
  return msg
    .replace(/token=[0-9a-f]{16,}/gi, 'token=***')
    .replace(/[0-9a-f]{40,}/gi, '***')
    .replace(/AUTH \S+ \S+/gi, 'AUTH ***')
    .slice(0, 300);
}

/**
 * Sends with bounded retries (3 attempts, 0.5 s / 2 s back-off) for TRANSIENT failures only (connection
 * problems, 4xx). `accepted` means the SMTP server accepted the message for delivery -- not that it reached the
 * inbox (SMTP gives no delivery confirmation; bounces arrive later at the sender address).
 */
export async function sendEmail(mail: OutgoingEmail, cfg: EmailConfig = emailConfig(), sender = smtpSend): Promise<SendOutcome> {
  if (!cfg.enabled || !cfg.smtp || !cfg.from) {
    return { status: 'suppressed', transport: 'none', errorCode: 'email_disabled', errorDetail: cfg.reason ?? 'E-mail není nastavený.', attempts: 0 };
  }
  if (isReservedRecipient(mail.to) && !cfg.allowReserved) {
    return { status: 'suppressed', transport: 'smtp', errorCode: 'reserved_domain', errorDetail: 'Testovací/fiktivní doména: e-mail se neodesílá.', attempts: 0 };
  }
  const fromAddr = addressOnly(cfg.from);
  const domain = fromAddr.split('@')[1] ?? 'clearspace.local';
  const { raw, messageId } = buildMime({ from: cfg.from, to: mail.to, replyTo: cfg.replyTo, subject: mail.subject, text: mail.text, html: mail.html, messageIdDomain: domain });
  const delays = [500, 2000];
  let last: SmtpError | Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await sender({ ...cfg.smtp, clientName: domain }, { from: fromAddr, to: mail.to }, raw);
      return { status: 'accepted', transport: 'smtp', messageId, attempts: attempt };
    } catch (err) {
      last = err as Error;
      const transient = err instanceof SmtpError ? err.transient : true;
      if (!transient || attempt === 3) break;
      await sleep(delays[attempt - 1]);
    }
  }
  const code = last instanceof SmtpError && last.code ? `smtp_${last.code}` : 'smtp_unreachable';
  return { status: 'failed', transport: 'smtp', errorCode: code, errorDetail: sanitizeError(last?.message ?? 'neznámá chyba'), attempts: 3 };
}
