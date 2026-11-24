import { emailConfig, isReservedRecipient, type EmailConfig } from './config';
import { smtpSend, composeMessage, SmtpError } from './smtp';

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

/** Bare address of "Name <addr>" (or the input itself). */
export function addressOnly(input: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(input);
  return (m ? m[1] : input).trim();
}

/**
 * Sends with bounded retries (3 attempts, 0.5 s / 2 s back-off) ONLY when nothing can have been submitted yet
 * (connection/TLS problems before the message, or a definite 4xx refusal). 5xx, bad credentials and certificate
 * errors are final. A failure while the message was being transferred without a server verdict is AMBIGUOUS:
 * the server may have taken it, so it is never retried automatically (no duplicate invitations); the UI says so.
 * `accepted` means the SMTP server accepted the message for delivery -- not that it reached the inbox.
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
  let msg: Awaited<ReturnType<typeof composeMessage>>;
  try {
    msg = await composeMessage({ from: cfg.from, to: mail.to, replyTo: cfg.replyTo, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (err) {
    return { status: 'failed', transport: 'smtp', errorCode: 'invalid_message', errorDetail: sanitizeError((err as Error).message), attempts: 0 };
  }
  const delays = [500, 2000];
  let last: Error | null = null;
  let attempt = 0;
  for (attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await sender({ ...cfg.smtp, clientName: domain }, { from: fromAddr, to: mail.to }, msg.raw);
      return { status: 'accepted', transport: 'smtp', messageId: msg.messageId, attempts: attempt };
    } catch (err) {
      last = err as Error;
      const retry = err instanceof SmtpError ? err.retry : 'ambiguous';
      if (retry === 'ambiguous') {
        return { status: 'failed', transport: 'smtp', errorCode: 'smtp_ambiguous', errorDetail: sanitizeError(`Server nepotvrdil převzetí, e-mail mohl přesto odejít. ${last.message}`), attempts: attempt };
      }
      if (retry !== 'safe' || attempt === 3) break;
      await sleep(delays[attempt - 1]);
    }
  }
  const code = last instanceof SmtpError && last.code ? `smtp_${last.code}` : 'smtp_unreachable';
  return { status: 'failed', transport: 'smtp', errorCode: code, errorDetail: sanitizeError(last?.message ?? 'neznámá chyba'), attempts: Math.min(attempt, 3) };
}
