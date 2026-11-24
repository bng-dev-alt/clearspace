import SMTPConnection from 'nodemailer/lib/smtp-connection';
import MailComposer from 'nodemailer/lib/mail-composer';

/**
 * SMTP submission through nodemailer's maintained SMTP connection (RUN 01C replaced the RUN 01B hand-written
 * client). We drive the low-level connection ourselves only to know WHERE a failure happened:
 *   connect/TLS/auth  -> nothing was submitted, a retry is safe (unless it is a config/credential error)
 *   during send       -> with an SMTP reply code the outcome is definite (4xx retry, 5xx give up);
 *                        without one (timeout, dropped connection) the server MAY have accepted the message,
 *                        so it is reported as AMBIGUOUS and never retried automatically (no duplicate e-mails).
 */
export type RetryClass = 'safe' | 'never' | 'ambiguous';

export class SmtpError extends Error {
  constructor(message: string, public readonly code: number | null, public readonly retry: RetryClass) {
    super(message);
  }
  get transient(): boolean { return this.retry === 'safe'; }
}

export interface SmtpOptions {
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  user?: string;
  password?: string;
  /** EHLO name */
  clientName?: string;
  /** hard cap for the whole session (connect .. final reply) */
  totalTimeoutMs?: number;
  /** test seam: accept self-signed certificates (never set by emailConfig) */
  rejectUnauthorized?: boolean;
}

export interface ComposedMessage { raw: Buffer; messageId: string }

/** RFC 5322 message (multipart/alternative, UTF-8, folded/encoded headers) built by nodemailer's MailComposer. */
export async function composeMessage(m: { from: string; to: string; replyTo?: string; subject: string; text: string; html: string }): Promise<ComposedMessage> {
  for (const v of [m.from, m.to, m.subject, m.replyTo ?? '']) {
    if (/[\r\n]/.test(v)) throw new SmtpError('header injection', null, 'never');
  }
  const node = new MailComposer({
    from: m.from, to: m.to, replyTo: m.replyTo, subject: m.subject, text: m.text, html: m.html,
    headers: { 'Auto-Submitted': 'auto-generated' },
  }).compile();
  return { raw: await node.build(), messageId: node.messageId() };
}

/** Envelope addresses go to the server verbatim: only plain addr-spec, nothing the server could re-parse. */
const PLAIN_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
export function isPlainAddress(a: string): boolean { return a.length <= 254 && PLAIN_ADDRESS.test(a); }

type NmError = Error & { code?: string; responseCode?: number; command?: string };

function classify(err: NmError, stage: 'connect' | 'auth' | 'send'): SmtpError {
  const rc = typeof err.responseCode === 'number' ? err.responseCode : null;
  const msg = `${err.code ?? 'SMTP'} ${err.command ?? ''}: ${err.message}`.replace(/\s+/g, ' ').slice(0, 240);
  if (rc !== null && rc >= 500) return new SmtpError(msg, rc, 'never');
  if (rc !== null && rc >= 400) return new SmtpError(msg, rc, 'safe'); // definite refusal, nothing accepted
  if (err.code === 'EAUTH' || err.code === 'ENOAUTH' || err.code === 'EENVELOPE' || err.code === 'EMESSAGE' || err.code === 'ECONFIG') {
    return new SmtpError(msg, rc, 'never');
  }
  // certificate problems do not heal by retrying and must not be "retried around"
  if (err.code === 'ETLS' || /certificate|self.signed|hostname|altnames/i.test(err.message)) return new SmtpError(msg, rc, 'never');
  if (stage === 'send') return new SmtpError(msg, rc, 'ambiguous');
  return new SmtpError(msg, rc, 'safe');
}

/** Sends one message on one connection. Resolves when the server accepted it (2xx) -- that is NOT inbox delivery. */
export function smtpSend(o: SmtpOptions, envelope: { from: string; to: string }, raw: Buffer | string): Promise<{ reply: string }> {
  if (!isPlainAddress(envelope.from) || !isPlainAddress(envelope.to)) {
    return Promise.reject(new SmtpError('Neplatná adresa v obálce zprávy.', null, 'never'));
  }
  const conn = new SMTPConnection({
    host: o.host,
    port: o.port,
    secure: o.security === 'tls',
    requireTLS: o.security === 'starttls', // STARTTLS mandatory: no plaintext fallback, no opportunistic mode
    ignoreTLS: o.security === 'none', // only allowed to a loopback capture server (emailConfig enforces it)
    name: o.clientName,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    tls: { servername: o.host, rejectUnauthorized: o.rejectUnauthorized ?? true, minVersion: 'TLSv1.2' },
  });
  let stage: 'connect' | 'auth' | 'send' = 'connect';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: NmError | null, reply?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { if (err) conn.close(); else conn.quit(); } catch { /* already closed */ }
      if (err) reject(classify(err, stage)); else resolve({ reply: (reply ?? '').slice(0, 200) });
    };
    const deadline = setTimeout(() => finish(Object.assign(new Error('SMTP session timeout'), { code: 'ETIMEDOUT' })), o.totalTimeoutMs ?? 25_000);
    conn.on('error', (e: NmError) => finish(e)); // stays attached: a late socket error must never crash the process
    conn.connect((cErr?: NmError | null) => {
      if (cErr) return finish(cErr);
      const send = () => {
        stage = 'send';
        conn.send({ from: envelope.from, to: [envelope.to] }, raw, (sErr, info) => finish(sErr as NmError | null, info?.response));
      };
      if (!o.user) return send();
      stage = 'auth';
      conn.login({ user: o.user, pass: o.password ?? '' }, (aErr) => (aErr ? finish(aErr as NmError) : send()));
    });
  });
}
