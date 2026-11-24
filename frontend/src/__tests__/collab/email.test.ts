import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emailConfig, appBaseUrl, isReservedRecipient } from '../../lib/email/config';
import { smtpSend, composeMessage, isPlainAddress, SmtpError } from '../../lib/email/smtp';
import { sendEmail, sanitizeError } from '../../lib/email/send';
import { invitationHtml, invitationText, invitationSubject, safeName } from '../../lib/email/invitationTemplate';
import { acceptUrl } from '../../lib/collab/invitationServer';

const base = {
  EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example-provider.cz', SMTP_PORT: '587', SMTP_SECURITY: 'starttls',
  EMAIL_FROM: 'ClearSpace <pozvanky@clearspace.cz>', APP_BASE_URL: 'https://clearspace-ai.vercel.app', EMAIL_SERVER_SECRET: 'x'.repeat(40),
} as unknown as NodeJS.ProcessEnv;

describe('email configuration', () => {
  it('is off unless explicitly configured', () => {
    expect(emailConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(emailConfig(base).enabled).toBe(true);
  });
  it('refuses unencrypted SMTP to anything but a loopback capture server', () => {
    expect(emailConfig({ ...base, SMTP_SECURITY: 'none' }).enabled).toBe(false);
    expect(emailConfig({ ...base, SMTP_SECURITY: 'none', SMTP_HOST: '127.0.0.1', APP_BASE_URL: 'http://127.0.0.1:3431' }).enabled).toBe(true);
  });
  it('needs the server secret and a sender', () => {
    expect(emailConfig({ ...base, EMAIL_SERVER_SECRET: 'short' }).enabled).toBe(false);
    expect(emailConfig({ ...base, EMAIL_FROM: 'not an address' }).enabled).toBe(false);
  });
  it('production links: https, public host, never localhost; no credentials/query in the base URL', () => {
    const prod = { VERCEL: '1', VERCEL_ENV: 'production', NODE_ENV: 'production' };
    expect(appBaseUrl({ ...prod, APP_BASE_URL: 'http://127.0.0.1:3431' } as unknown as NodeJS.ProcessEnv).error).toBeTruthy();
    expect(appBaseUrl({ ...prod, APP_BASE_URL: 'https://localhost' } as unknown as NodeJS.ProcessEnv).error).toBeTruthy();
    expect(appBaseUrl({ ...prod, APP_BASE_URL: 'https://clearspace-ai.vercel.app/' } as unknown as NodeJS.ProcessEnv).url).toBe('https://clearspace-ai.vercel.app');
    expect(appBaseUrl({ APP_BASE_URL: 'https://u:p@evil.example/x?y=1' } as unknown as NodeJS.ProcessEnv).error).toBeTruthy();
    expect(appBaseUrl({ APP_BASE_URL: 'http://evil.example' } as unknown as NodeJS.ProcessEnv).error).toBeTruthy();
    expect(appBaseUrl({} as NodeJS.ProcessEnv).error).toBeTruthy();
  });
  it('reserved/fictional recipients (RUN 00 demo data uses example.com/.org/.net)', () => {
    for (const e of ['dana.whitfield@example.com', 'mei.tanaka@example.org', 'x@example.net', 'a@mail.example.com', 'b@foo.test', 'c@foo.invalid', 'd@localhost', 'e@team.example']) {
      expect(isReservedRecipient(e), e).toBe(true);
    }
    for (const e of ['jan@seznam.cz', 'anna@firma.com', 'x@examples.com', 'y@testing.cz']) expect(isReservedRecipient(e), e).toBe(false);
  });
  it('reserved domains are allowed ONLY into a loopback capture server outside production', () => {
    expect(emailConfig({ ...base, EMAIL_ALLOW_RESERVED_DOMAINS: '1' }).allowReserved).toBe(false);
    const local = { ...base, SMTP_HOST: '127.0.0.1', SMTP_SECURITY: 'none', APP_BASE_URL: 'http://127.0.0.1:3431', EMAIL_ALLOW_RESERVED_DOMAINS: '1' } as unknown as NodeJS.ProcessEnv;
    expect(emailConfig(local).allowReserved).toBe(true);
    expect(emailConfig({ ...local, VERCEL: '1', VERCEL_ENV: 'production' }).allowReserved).toBe(false);
  });
});

describe('message building (nodemailer MailComposer)', () => {
  it('encodes Czech headers and refuses header injection', async () => {
    const { raw } = await composeMessage({ from: 'Šárka z ClearSpace <a@x.cz>', to: 'b@x.cz', subject: 'Pozvánka do projektu Stěhování', text: 't', html: 'h' });
    const head = raw.toString().split('\r\n\r\n')[0];
    expect(head).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(head).toMatch(/^From: =\?UTF-8\?.+<a@x\.cz>$/m);
    expect(head).toMatch(/^Auto-Submitted: auto-generated$/m);
    await expect(composeMessage({ from: 'a@x.cz', to: 'b@x.cz\r\nBcc: c@x.cz', subject: 's', text: 't', html: 'h' })).rejects.toThrow(/injection/);
    await expect(composeMessage({ from: 'a@x.cz', to: 'b@x.cz', subject: 's\nBcc: c@x.cz', text: 't', html: 'h' })).rejects.toThrow(/injection/);
  });
  it('multipart/alternative with plain text first; long Czech subjects are folded under the line limit', async () => {
    const { raw, messageId } = await composeMessage({ from: 'ClearSpace <a@x.cz>', to: 'b@x.cz', subject: `Žluťoučký kůň ${'úpěl ďábelské ódy '.repeat(20)}`, text: 'čeština', html: '<p>čeština</p>' });
    const s = raw.toString();
    expect(messageId).toMatch(/^<.+@x\.cz>$/);
    expect(s).toContain('Content-Type: multipart/alternative');
    expect(s.indexOf('text/plain')).toBeLessThan(s.indexOf('text/html'));
    expect(s.split('\r\n').every((l) => l.length <= 998)).toBe(true);
    expect(s).not.toMatch(/[^\r]\n/);
  });
  it('envelope addresses must be plain addr-spec', () => {
    expect(isPlainAddress('jan.novak+tag@firma.cz')).toBe(true);
    for (const a of ['a@b', '"x@y"@z.cz', 'a b@c.cz', 'a@c.cz>', '<a@c.cz>', 'a@c.cz\r\nRCPT TO:<x@y.cz>']) expect(isPlainAddress(a), a).toBe(false);
  });
});

describe('invitation template', () => {
  const d = { inviterName: 'Alice <script>', projectName: 'Projekt "X" & spol.', role: 'viewer' as const, acceptUrl: 'https://clearspace-ai.vercel.app/accept-invite?token=' + 'a'.repeat(64), expiresAt: '2026-12-01T10:00:00Z' };
  it('is Czech, names inviter, project, role, expiry and has a plain-text twin', () => {
    const t = invitationText(d);
    expect(t).toContain('vás zve ke spolupráci na projektu');
    expect(t).toContain('čtenář');
    expect(t).toContain('Odkaz platí do 1. prosince 2026');
    expect(t).toContain('Pokud pozvánku nečekáte');
    expect(t).toContain(d.acceptUrl);
    expect(invitationSubject(d)).toContain('vás zve do projektu');
  });
  it('escapes untrusted names in HTML and defuses links in names', () => {
    const h = invitationHtml(d);
    expect(h).not.toContain('<script>');
    expect(h).toContain('Alice &lt;script&gt;');
    expect(h).toContain('Projekt &quot;X&quot; &amp; spol.');
    expect(h).toContain('Přijmout pozvánku');
    expect(safeName('Pozor www.evil.cz https://phish.example')).not.toMatch(/https:\/\/|www\./);
    expect(safeName('a\r\nBcc: x')).toBe('a Bcc: x');
  });
  it('links are built from the configured base only', () => {
    expect(acceptUrl('https://clearspace-ai.vercel.app', 'abc')).toBe('https://clearspace-ai.vercel.app/accept-invite?token=abc');
  });
});

// ---- SMTP client against an in-process fake server -------------------------------------------------
type Script = { onRcpt?: string; onData?: string; ehlo?: string[]; afterData?: 'silent' | 'close' };
const servers: net.Server[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.close()); });
function fakeSmtp(script: Script = {}): Promise<{ port: number; log: string[]; messages: string[] }> {
  const log: string[] = []; const messages: string[] = [];
  const server = net.createServer((sock) => {
    let data = false; let buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      if (data) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end === -1) return;
        messages.push(buf.slice(0, end)); buf = buf.slice(end + 5); data = false;
        if (script.afterData === 'silent') return; // accepted or not? the client cannot know
        if (script.afterData === 'close') { sock.destroy(); return; }
        sock.write(script.onData ?? '250 2.0.0 queued as X\r\n');
        return;
      }
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); log.push(line);
        if (/^EHLO/.test(line)) sock.write(['250-fake', ...(script.ehlo ?? ['AUTH PLAIN LOGIN']).map((l) => `250-${l}`), '250 SIZE 1000000'].join('\r\n') + '\r\n');
        else if (/^AUTH PLAIN/.test(line)) sock.write('235 ok\r\n');
        else if (/^STARTTLS/.test(line)) sock.write('502 not here\r\n');
        else if (/^MAIL FROM/.test(line)) sock.write('250 ok\r\n');
        else if (/^RCPT TO/.test(line)) sock.write(script.onRcpt ?? '250 ok\r\n');
        else if (line === 'DATA') { sock.write('354 go\r\n'); data = true; }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('502 ?\r\n');
      }
    });
  });
  servers.push(server);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ port: (server.address() as net.AddressInfo).port, log, messages })));
}

const until = async (f: () => boolean) => { for (let i = 0; i < 50 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };

describe('SMTP client (nodemailer connection)', () => {
  it('sends one message (EHLO, AUTH only when configured, MAIL, RCPT, DATA, QUIT)', async () => {
    const srv = await fakeSmtp();
    await smtpSend({ host: '127.0.0.1', port: srv.port, security: 'none', user: 'u', password: 'p' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'Subject: t\r\n\r\nbody\r\n.leading dot');
    await until(() => srv.log.includes('QUIT'));
    expect(srv.log.map((l) => l.split(' ')[0])).toEqual(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    expect(srv.messages[0]).toContain('body');
    expect(srv.messages[0]).toContain('\r\n..leading dot'); // dot-stuffing
  });
  it('STARTTLS is required when configured: no plaintext fallback, nothing sent before TLS', async () => {
    const srv = await fakeSmtp({ ehlo: ['AUTH PLAIN'] });
    await expect(smtpSend({ host: '127.0.0.1', port: srv.port, security: 'starttls', user: 'u', password: 'p' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x')).rejects.toMatchObject({ retry: 'never' });
    expect(srv.log.some((l) => l.startsWith('AUTH') || l.startsWith('MAIL'))).toBe(false);
  });
  it('4xx is a definite refusal (safe to retry), 5xx is permanent', async () => {
    const t = await fakeSmtp({ onRcpt: '451 try later\r\n' });
    await expect(smtpSend({ host: '127.0.0.1', port: t.port, security: 'none' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x')).rejects.toMatchObject({ retry: 'safe', code: 451 });
    const p = await fakeSmtp({ onRcpt: '550 no such user\r\n' });
    await expect(smtpSend({ host: '127.0.0.1', port: p.port, security: 'none' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x')).rejects.toMatchObject({ retry: 'never', code: 550 });
    const d = await fakeSmtp({ onData: '452 mailbox full\r\n' });
    await expect(smtpSend({ host: '127.0.0.1', port: d.port, security: 'none' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x')).rejects.toMatchObject({ retry: 'safe', code: 452 });
  });
  it('connection dropped after the message was transferred = AMBIGUOUS (may have been accepted)', async () => {
    const srv = await fakeSmtp({ afterData: 'close' });
    await expect(smtpSend({ host: '127.0.0.1', port: srv.port, security: 'none' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x')).rejects.toMatchObject({ retry: 'ambiguous' });
  });
  it('a silent server cannot hang the request: the whole session is capped', async () => {
    const srv = await fakeSmtp({ afterData: 'silent' });
    const t0 = Date.now();
    await expect(smtpSend({ host: '127.0.0.1', port: srv.port, security: 'none', totalTimeoutMs: 800 }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x')).rejects.toMatchObject({ retry: 'ambiguous' });
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('nothing listening = safe to retry (nothing was submitted)', async () => {
    const srv = await fakeSmtp(); const port = srv.port; servers.splice(0).forEach((s) => s.close());
    await new Promise((r) => setTimeout(r, 50));
    await expect(smtpSend({ host: '127.0.0.1', port, security: 'none' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x')).rejects.toMatchObject({ retry: 'safe' });
  });
  it('refuses a malformed envelope before connecting', async () => {
    await expect(smtpSend({ host: '127.0.0.1', port: 1, security: 'none' }, { from: 'a@x.cz', to: 'x@y.cz>\r\nRCPT TO:<z@w.cz' }, 'x')).rejects.toMatchObject({ retry: 'never' });
  });
});

// ---- TLS certificate validation against a real TLS server with a self-signed certificate -----------------
let cert: { key: string; cert: string } | null = null;
beforeAll(() => {
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'cs-smtp-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
    cert = { key: readFileSync(path.join(dir, 'k.pem'), 'utf8'), cert: readFileSync(path.join(dir, 'c.pem'), 'utf8') };
  } catch { cert = null; }
});
function tlsSmtp(): Promise<{ port: number; sawMail: () => boolean }> {
  let mail = false;
  const server = tls.createServer({ key: cert!.key, cert: cert!.cert }, (sock) => {
    sock.write('220 tls ESMTP\r\n');
    sock.on('data', (d) => {
      const line = d.toString();
      if (/^EHLO/.test(line)) sock.write('250-tls\r\n250 AUTH PLAIN\r\n');
      else if (/^AUTH/.test(line)) sock.write('235 ok\r\n');
      else if (/^MAIL/.test(line)) { mail = true; sock.write('250 ok\r\n'); }
      else if (/^QUIT/.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    });
    sock.on('error', () => undefined);
  });
  servers.push(server as unknown as net.Server);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ port: (server.address() as net.AddressInfo).port, sawMail: () => mail })));
}
describe('SMTP TLS certificate validation', () => {
  it('rejects an untrusted certificate before sending credentials, and does not retry around it', async (ctx) => {
    if (!cert) ctx.skip();
    const srv = await tlsSmtp();
    await expect(smtpSend({ host: '127.0.0.1', port: srv.port, security: 'tls', user: 'u', password: 'p' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x')).rejects.toMatchObject({ retry: 'never' });
    expect(srv.sawMail()).toBe(false);
  });
  it('control: the same server works only when validation is explicitly disabled (test seam)', async (ctx) => {
    if (!cert) ctx.skip();
    const srv = await tlsSmtp();
    // the toy server's DATA handling is minimal; what matters is that the session got past TLS to MAIL FROM
    await smtpSend({ host: '127.0.0.1', port: srv.port, security: 'tls', rejectUnauthorized: false, totalTimeoutMs: 1500 }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x').catch(() => undefined);
    expect(srv.sawMail()).toBe(true);
  });
});

describe('sendEmail (bounded retries, honest outcomes)', () => {
  const cfgFor = (port: number) => emailConfig({ ...base, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURITY: 'none', APP_BASE_URL: 'http://127.0.0.1:3431', EMAIL_ALLOW_RESERVED_DOMAINS: '1' } as unknown as NodeJS.ProcessEnv);
  const mail = { to: 'novy@firma.cz', subject: 'Pozvánka', text: 't', html: '<p>t</p>' };
  it('accepted = the server took it (not "delivered")', async () => {
    const srv = await fakeSmtp();
    const r = await sendEmail(mail, cfgFor(srv.port));
    expect(r).toMatchObject({ status: 'accepted', attempts: 1 });
  });
  it('retries transient failures at most 3 times, then reports failure', async () => {
    let calls = 0;
    const r = await sendEmail(mail, cfgFor(1), async () => { calls += 1; throw new SmtpError('ESOCKET CONN: ECONNREFUSED', null, 'safe'); });
    expect(calls).toBe(3);
    expect(r).toMatchObject({ status: 'failed', errorCode: 'smtp_unreachable', attempts: 3 });
  }, 10000);
  it('does not retry permanent failures', async () => {
    let calls = 0;
    const r = await sendEmail(mail, cfgFor(1), async () => { calls += 1; throw new SmtpError('550 nope', 550, 'never'); });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ status: 'failed', errorCode: 'smtp_550' });
  });
  it('an ambiguous failure is never retried (no duplicate invitation) and is reported as uncertain', async () => {
    const srv = await fakeSmtp({ afterData: 'close' });
    const r = await sendEmail(mail, cfgFor(srv.port));
    expect(r).toMatchObject({ status: 'failed', errorCode: 'smtp_ambiguous', attempts: 1 });
    expect(srv.messages).toHaveLength(1);
  });
  it('a definite 4xx after the message is retried and then accepted once', async () => {
    let calls = 0;
    const r = await sendEmail(mail, cfgFor(1), async () => { calls += 1; if (calls === 1) throw new SmtpError('451', 451, 'safe'); return { reply: '250' }; });
    expect(r).toMatchObject({ status: 'accepted', attempts: 2 });
  });
  it('never sends to a reserved/fictional domain through a real server', async () => {
    let calls = 0;
    const r = await sendEmail({ ...mail, to: 'dana.whitfield@example.com' }, emailConfig(base), async () => { calls += 1; return { reply: '' }; });
    expect(calls).toBe(0);
    expect(r).toMatchObject({ status: 'suppressed', errorCode: 'reserved_domain' });
  });
  it('without configuration nothing is sent', async () => {
    const r = await sendEmail(mail, emailConfig({} as NodeJS.ProcessEnv));
    expect(r).toMatchObject({ status: 'suppressed', errorCode: 'email_disabled' });
  });
  it('error details never keep tokens or credentials', () => {
    expect(sanitizeError(`AUTH PLAIN AGFiYwBwYXNz failed token=${'a'.repeat(64)}`)).not.toMatch(/AGFiYwBwYXNz|a{40}/);
  });
});
