import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { emailConfig, appBaseUrl, isReservedRecipient } from '../../lib/email/config';
import { buildMime, encodeHeaderWord, formatAddress } from '../../lib/email/mime';
import { smtpSend, dataBlock, SmtpError } from '../../lib/email/smtp';
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

describe('message building', () => {
  it('encodes Czech headers and refuses header injection', () => {
    expect(encodeHeaderWord('Pozvánka')).toMatch(/^=\?UTF-8\?B\?/);
    expect(encodeHeaderWord('Hello')).toBe('Hello');
    expect(formatAddress('Šárka <s@x.cz>')).toMatch(/^=\?UTF-8\?B\?.+\?= <s@x\.cz>$/);
    expect(() => formatAddress('x\r\nBcc: evil@x.cz')).toThrow();
    expect(() => buildMime({ from: 'a@x.cz', to: 'b@x.cz\r\nBcc: c@x.cz', subject: 's', text: 't', html: 'h', messageIdDomain: 'x.cz' })).toThrow();
  });
  it('multipart/alternative with plain text first, base64 UTF-8 bodies', () => {
    const { raw, messageId } = buildMime({ from: 'ClearSpace <a@x.cz>', to: 'b@x.cz', subject: 'Žluťoučký kůň', text: 'čeština', html: '<p>čeština</p>', messageIdDomain: 'x.cz' });
    expect(messageId).toMatch(/^<[0-9a-f]{32}@x\.cz>$/);
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'));
    expect(raw).toContain(Buffer.from('čeština').toString('base64'));
    expect(raw).not.toMatch(/[^\r]\n/);
  });
  it('dot-stuffs DATA lines', () => {
    expect(dataBlock('a\n.b\n..c')).toBe('a\r\n..b\r\n...c');
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
type Script = { onRcpt?: string; onData?: string; ehlo?: string[] };
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
        sock.write(script.onData ?? '250 2.0.0 queued as X\r\n');
        return;
      }
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); log.push(line);
        if (/^EHLO/.test(line)) sock.write(['250-fake', ...(script.ehlo ?? ['AUTH PLAIN LOGIN']).map((l) => `250-${l}`), '250 SIZE 1000000'].join('\r\n') + '\r\n');
        else if (/^AUTH PLAIN/.test(line)) sock.write('235 ok\r\n');
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

describe('SMTP client', () => {
  it('sends one message (EHLO, AUTH only when configured, MAIL, RCPT, DATA, QUIT)', async () => {
    const srv = await fakeSmtp();
    await smtpSend({ host: '127.0.0.1', port: srv.port, security: 'none', user: 'u', password: 'p' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'Subject: t\r\n\r\nbody');
    expect(srv.log.map((l) => l.split(' ')[0])).toEqual(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    expect(srv.messages[0]).toContain('body');
  });
  it('STARTTLS is required when configured (no silent downgrade)', async () => {
    const srv = await fakeSmtp({ ehlo: ['AUTH PLAIN'] });
    await expect(smtpSend({ host: '127.0.0.1', port: srv.port, security: 'starttls' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x')).rejects.toThrow(/STARTTLS/);
    expect(srv.log.some((l) => l.startsWith('AUTH') || l.startsWith('MAIL'))).toBe(false);
  });
  it('4xx is transient, 5xx is permanent', async () => {
    const t = await fakeSmtp({ onRcpt: '451 try later\r\n' });
    await expect(smtpSend({ host: '127.0.0.1', port: t.port, security: 'none' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x')).rejects.toMatchObject({ transient: true, code: 451 });
    const p = await fakeSmtp({ onRcpt: '550 no such user\r\n' });
    await expect(smtpSend({ host: '127.0.0.1', port: p.port, security: 'none' }, { from: 'a@x.cz', to: 'b@x.cz' }, 'x')).rejects.toMatchObject({ transient: false, code: 550 });
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
    const r = await sendEmail(mail, cfgFor(1), async () => { calls += 1; throw new SmtpError('SMTP connect: ECONNREFUSED', null, true); });
    expect(calls).toBe(3);
    expect(r).toMatchObject({ status: 'failed', errorCode: 'smtp_unreachable', attempts: 3 });
  }, 10000);
  it('does not retry permanent failures', async () => {
    let calls = 0;
    const r = await sendEmail(mail, cfgFor(1), async () => { calls += 1; throw new SmtpError('550 nope', 550, false); });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ status: 'failed', errorCode: 'smtp_550' });
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
