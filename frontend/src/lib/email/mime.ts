import { randomBytes } from 'node:crypto';

/** RFC 2047 encoded-word for non-ASCII header text (subject, display names). */
export function encodeHeaderWord(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** "Name <addr>" with the display name encoded when needed. Header injection (CR/LF) is refused. */
export function formatAddress(input: string): string {
  if (/[\r\n]/.test(input)) throw new Error('header injection');
  const m = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(input);
  if (!m) return input.trim();
  const name = m[1].replace(/^"|"$/g, '');
  return name ? `${encodeHeaderWord(name)} <${m[2]}>` : `<${m[2]}>`;
}

export function addressOnly(input: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(input);
  return (m ? m[1] : input).trim();
}

function base64Lines(text: string): string {
  return (Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

export interface MimeMessage {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  /** domain part for the Message-ID */
  messageIdDomain: string;
}

/** multipart/alternative (plain text first, then HTML), base64 UTF-8 bodies, CRLF line endings. */
export function buildMime(msg: MimeMessage): { raw: string; messageId: string } {
  for (const v of [msg.to, msg.subject, msg.replyTo ?? '']) {
    if (/[\r\n]/.test(v)) throw new Error('header injection');
  }
  const boundary = `cs-${randomBytes(12).toString('hex')}`;
  const messageId = `<${randomBytes(16).toString('hex')}@${msg.messageIdDomain}>`;
  const headers = [
    `From: ${formatAddress(msg.from)}`,
    `To: ${formatAddress(msg.to)}`,
    ...(msg.replyTo ? [`Reply-To: ${formatAddress(msg.replyTo)}`] : []),
    `Subject: ${encodeHeaderWord(msg.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', base64Lines(body)].join('\r\n');
  const raw = [headers.join('\r\n'), '', part('text/plain', msg.text), part('text/html', msg.html), `--${boundary}--`, ''].join('\r\n');
  return { raw, messageId };
}
