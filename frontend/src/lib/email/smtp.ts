import net from 'node:net';
import tls from 'node:tls';

/**
 * Minimal SMTP submission client (RFC 5321 + STARTTLS RFC 3207 + AUTH PLAIN/LOGIN RFC 4954), no dependency.
 * One message per connection. Throws SmtpError with the server's reply code; `transient` = worth a retry
 * (connection problems, 4xx). Credentials only after TLS (or to a loopback capture server).
 */
export class SmtpError extends Error {
  constructor(message: string, public readonly code: number | null, public readonly transient: boolean) {
    super(message);
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  user?: string;
  password?: string;
  /** EHLO name */
  clientName?: string;
  timeoutMs?: number;
  /** test seam: accept self-signed certificates (never set in production code paths) */
  rejectUnauthorized?: boolean;
}

interface Reply { code: number; lines: string[] }

class Conn {
  private buf = '';
  private waiters: ((r: Reply | Error) => void)[] = [];
  private socket: net.Socket | tls.TLSSocket;
  constructor(socket: net.Socket | tls.TLSSocket, private timeoutMs: number) {
    this.socket = socket;
    this.attach(socket);
  }
  private attach(s: net.Socket | tls.TLSSocket) {
    s.setEncoding('utf8');
    s.setTimeout(this.timeoutMs, () => this.fail(new SmtpError('SMTP timeout', null, true)));
    s.on('data', (d: string) => { this.buf += d; this.drain(); });
    s.on('error', (e) => this.fail(new SmtpError(`SMTP connection error: ${e.message}`, null, true)));
    s.on('close', () => this.fail(new SmtpError('SMTP connection closed', null, true)));
  }
  private fail(e: Error) { const w = this.waiters.splice(0); w.forEach((f) => f(e)); }
  private drain() {
    for (;;) {
      const lines = this.buf.split('\r\n');
      const done = lines.findIndex((l) => /^\d{3} /.test(l));
      if (done === -1 || done === lines.length - 1) return;
      const replyLines = lines.slice(0, done + 1);
      this.buf = lines.slice(done + 1).join('\r\n');
      const w = this.waiters.shift();
      if (w) w({ code: Number(replyLines[done].slice(0, 3)), lines: replyLines.map((l) => l.slice(4)) });
    }
  }
  read(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      this.waiters.push((r) => (r instanceof Error ? reject(r) : resolve(r)));
      this.drain();
    });
  }
  async cmd(line: string, expect: number[], redact = false): Promise<Reply> {
    this.socket.write(`${line}\r\n`);
    const r = await this.read();
    if (!expect.includes(r.code)) {
      const what = redact ? line.split(' ')[0] : line.split(' ').slice(0, 2).join(' ');
      throw new SmtpError(`SMTP ${what} -> ${r.code} ${r.lines.join(' ').slice(0, 200)}`, r.code, r.code >= 400 && r.code < 500);
    }
    return r;
  }
  upgrade(host: string, rejectUnauthorized: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeAllListeners('data'); plain.removeAllListeners('close'); plain.removeAllListeners('error'); plain.setTimeout(0);
      const secure = tls.connect({ socket: plain as net.Socket, servername: host, rejectUnauthorized }, () => resolve());
      secure.once('error', (e) => reject(new SmtpError(`TLS: ${e.message}`, null, true)));
      this.socket = secure;
      this.attach(secure);
    });
  }
  end() { try { this.socket.end(); } catch { /* closed */ } }
  write(data: string) { this.socket.write(data); }
}

function connect(o: SmtpOptions): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const rejectUnauthorized = o.rejectUnauthorized ?? true;
    const s = o.security === 'tls'
      ? tls.connect({ host: o.host, port: o.port, servername: o.host, rejectUnauthorized }, () => resolve(s))
      : net.connect({ host: o.host, port: o.port }, () => resolve(s));
    s.once('error', (e) => reject(new SmtpError(`SMTP connect: ${e.message}`, null, true)));
    s.setTimeout(o.timeoutMs ?? 15000, () => { s.destroy(); reject(new SmtpError('SMTP connect timeout', null, true)); });
  });
}

/** Dot-stuffing and CRLF normalisation for DATA. */
export function dataBlock(raw: string): string {
  return raw.replace(/\r?\n/g, '\r\n').split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
}

/** Sends one message. Resolves with the server's final reply (2xx = accepted for delivery, NOT delivered). */
export async function smtpSend(o: SmtpOptions, envelope: { from: string; to: string }, raw: string): Promise<{ reply: string }> {
  const socket = await connect(o);
  const c = new Conn(socket, o.timeoutMs ?? 15000);
  try {
    const greet = await c.read();
    if (greet.code !== 220) throw new SmtpError(`SMTP greeting ${greet.code}`, greet.code, greet.code >= 400 && greet.code < 500);
    const name = o.clientName ?? 'clearspace.local';
    let ehlo = await c.cmd(`EHLO ${name}`, [250]);
    if (o.security === 'starttls') {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new SmtpError('Server nenabízí STARTTLS', null, false);
      await c.cmd('STARTTLS', [220]);
      await c.upgrade(o.host, o.rejectUnauthorized ?? true);
      ehlo = await c.cmd(`EHLO ${name}`, [250]);
    }
    if (o.user && o.password) {
      const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) ?? '';
      if (/\bPLAIN\b/i.test(auth)) {
        await c.cmd(`AUTH PLAIN ${Buffer.from(`\u0000${o.user}\u0000${o.password}`).toString('base64')}`, [235], true);
      } else if (/\bLOGIN\b/i.test(auth)) {
        await c.cmd('AUTH LOGIN', [334]);
        await c.cmd(Buffer.from(o.user).toString('base64'), [334], true);
        await c.cmd(Buffer.from(o.password).toString('base64'), [235], true);
      } else {
        throw new SmtpError('Server nenabízí podporovanou metodu AUTH', null, false);
      }
    }
    await c.cmd(`MAIL FROM:<${envelope.from}>`, [250]);
    await c.cmd(`RCPT TO:<${envelope.to}>`, [250, 251]);
    await c.cmd('DATA', [354]);
    c.write(`${dataBlock(raw)}\r\n.\r\n`);
    const done = await c.read();
    if (done.code !== 250) throw new SmtpError(`SMTP DATA -> ${done.code} ${done.lines.join(' ').slice(0, 200)}`, done.code, done.code >= 400 && done.code < 500);
    await c.cmd('QUIT', [221]).catch(() => undefined);
    return { reply: done.lines.join(' ').slice(0, 200) };
  } finally {
    c.end();
  }
}
