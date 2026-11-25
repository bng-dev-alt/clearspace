import { describe, it, expect, vi, afterEach } from 'vitest';
import { googleConfig } from '../../lib/google/config';
import { buildQuery, getContent, getItem, gmailWebUrl, isGmailId, linkRef, normalizeItem, parseFrom, search, sharedSender, GMAIL_TEXT } from '../../lib/google/gmail';
import { charsetOf, cleanLine, decodeBody, decodeEntities, extractText, htmlToText, MAX_TEXT_CHARS, type GmailPart } from '../../lib/google/mime';

const cfg = (() => {
  const c = googleConfig({ GOOGLE_OAUTH_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 's', GOOGLE_SERVER_SECRET: 'g'.repeat(40),
    GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), GOOGLE_PICKER_API_KEY: 'AIzaTestKey_123456', GOOGLE_CLOUD_PROJECT_NUMBER: '1234567', APP_BASE_URL: 'https://c.example' } as unknown as NodeJS.ProcessEnv);
  if (!c.enabled) throw new Error(c.reason);
  return c;
})();
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const plain = (text: string, charset = 'utf-8', bytes?: Buffer): GmailPart => ({ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: `text/plain; charset=${charset}` }], body: { data: b64(bytes ?? text) } });
const html = (h: string): GmailPart => ({ mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { data: b64(h) } });
const ID = '18c3a5e000000000';
const T = '18c3a5e000000003';

describe('MIME: plain text preferred, charsets, bad input', () => {
  it('multipart/alternative: plain part wins; attachments are metadata only (never data)', () => {
    const r = extractText({ mimeType: 'multipart/mixed', parts: [
      { mimeType: 'multipart/alternative', parts: [plain('Faktura je v příloze.'), html('<p>Faktura <b>HTML</b></p>')] },
      { mimeType: 'application/pdf', filename: 'faktura.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { size: 48213, attachmentId: 'ANGj' } },
    ] });
    expect(r).toMatchObject({ text: 'Faktura je v příloze.', fromHtml: false, missing: false, truncated: false });
    expect(r.attachments).toEqual([{ name: 'faktura.pdf', mimeType: 'application/pdf', size: 48213 }]);
  });
  it('decodes the part charset (windows-1250, iso-8859-2); unknown / invalid fall back to UTF-8 with replacement', () => {
    const cz = 'Příliš žluťoučký kůň úpěl ďábelské ódy.';
    const cp = Buffer.from('50f8ed6c699a209e6c759d6f75e86bfd206bf9f220fa70ec6c20efe162656c736be920f364792e', 'hex');
    expect(extractText({ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="windows-1250"' }], body: { data: b64(cp) } }).text).toBe(cz);
    expect(decodeBody(b64(Buffer.from([0x50, 0xf8, 0xed])), 'iso-8859-2')).toBe('Pří');
    expect(decodeBody(b64('ahoj'), 'x-no-such-charset')).toBe('ahoj');
    const broken = decodeBody(b64(Buffer.from([0x50, 0xc5, 0x99, 0xc3, 0x28, 0xff])), 'utf-8');
    expect(broken.startsWith('Př')).toBe(true);
    expect(broken).toContain('�');
    expect(charsetOf('text/plain; charset=UTF-8')).toBe('utf-8');
  });
  it('missing body, empty payload, deep / huge trees are bounded', () => {
    expect(extractText(undefined)).toMatchObject({ missing: true, text: '' });
    expect(extractText({ mimeType: 'text/plain', body: { size: 0 } }).missing).toBe(true);
    let deep: GmailPart = plain('hluboko');
    for (let i = 0; i < 40; i++) deep = { mimeType: 'multipart/mixed', parts: [deep] };
    expect(extractText(deep).missing).toBe(true);                    // beyond MAX_DEPTH: not walked
    const many = { mimeType: 'multipart/mixed', parts: Array.from({ length: 500 }, (_, i) => ({ mimeType: 'image/png', filename: `a${i}.png`, body: { size: 1, attachmentId: 'x' } })) };
    expect(extractText(many).attachments.length).toBeLessThanOrEqual(50);
  });
  it('long messages are truncated; control and bidi characters stripped', () => {
    const r = extractText(plain('x'.repeat(MAX_TEXT_CHARS + 500)));
    expect(r.text.length).toBe(MAX_TEXT_CHARS);
    expect(r.truncated).toBe(true);
    expect(extractText(plain('a\u0000b‮c\r\nd')).text).toBe('abc\nd');
    expect(cleanLine('  <b>x</b>\n\t y\u0007 ', 50, '-')).toBe('<b>x</b> y');
  });
});

describe('HTML is reduced to text, never rendered', () => {
  it('drops script/style/head/iframe/svg, comments, images (tracking pixels), forms and link targets', () => {
    const t = htmlToText('<html><head><title>T</title><style>p{}</style><script>alert("x")</script></head><body><!-- c --><h1>Novinky</h1><p>Nový <a href="javascript:alert(1)">odkaz</a> &amp; akce &ndash; 20&nbsp;%.</p><img src="https://tracker.example/p.gif"><iframe src="https://evil.example">x</iframe><svg><script>1</script></svg><form action="https://evil.example"><input name="p"></form><ul><li>A</li><li>B</li></ul></body></html>');
    expect(t).toContain('Novinky');
    expect(t).toContain('Nový odkaz & akce – 20 %.');
    expect(t).toContain('• A');
    for (const bad of ['alert', 'tracker.example', 'evil.example', 'javascript:', '<', 'p{}']) expect(t).not.toContain(bad);
  });
  it('unclosed script/comment drop the rest; entity decoding is safe', () => {
    expect(htmlToText('ok<script>steal()')).toBe('ok');
    expect(htmlToText('ok<!-- never closed <b>x</b>')).toBe('ok');
    expect(decodeEntities('&#60;script&#62; &#x1F600; &#0; &#xD800; &bogus;')).toBe('<script> 😀   &bogus;');
  });
  it('is linear on adversarial input (no catastrophic backtracking)', () => {
    const evil = '<script>'.repeat(20_000) + '<a '.repeat(20_000) + '<!--'.repeat(10_000);
    const t0 = Date.now();
    htmlToText(evil);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('Gmail search query, ids, sender privacy', () => {
  it('builds q from validated fields; values cannot inject grouping/operators', () => {
    expect(buildQuery({ text: 'nabídka', from: 'Jana Dvořáková', subject: 'Corvane', after: '2026-11-01', before: '2026-11-30' }))
      .toBe('nabídka from:(Jana Dvořáková) subject:(Corvane) after:2026/11/01 before:2026/11/30');
    expect(buildQuery({ from: 'x) OR in:anywhere (y', subject: '"a"\\', after: '2026-13-45', before: 'yesterday' })).toBe('from:(x OR in:anywhere y) subject:(a)');
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ text: 'a'.repeat(500) }).length).toBe(200);
  });
  it('Gmail ids: hex only (no paths, URLs, other formats)', () => {
    expect(isGmailId(ID)).toBe(true);
    for (const bad of ['../../x', 'http://169.254.169.254', 'ABCDEF0123', 'mockDoc_SmlouvaCorvane01', '', null, 42]) expect(isGmailId(bad)).toBe(false);
    expect(gmailWebUrl(T)).toBe(`https://mail.google.com/mail/u/0/#all/${T}`);
    expect(gmailWebUrl('javascript:x')).toBeNull();
  });
  it('the shared sender is a display name or only the domain, never the address', () => {
    const f = parseFrom('"Jana Dvořáková (simulace)" <Jana.Dvorakova@Corvane.example>');
    expect(f).toEqual({ name: 'Jana Dvořáková (simulace)', address: 'jana.dvorakova@corvane.example', domain: 'corvane.example' });
    expect(sharedSender(f)).toBe('Jana Dvořáková (simulace)');
    expect(sharedSender(parseFrom('robot@chyby.example'))).toBe('@chyby.example');
    expect(sharedSender(parseFrom(''))).toBe('Neznámý odesílatel');
    expect(sharedSender(parseFrom('"<img src=x onerror=alert(1)>" <xss@evil.example>'))).toBe('<img src=x onerror=alert(1)>');
  });
  it('link refs are opaque, deterministic per (account, kind, id) and differ across accounts', () => {
    const a = linkRef(cfg, '1001', 'thread', T);
    expect(a).toMatch(/^[A-Za-z0-9_-]{40}$/);
    expect(a).not.toContain(T);
    expect(linkRef(cfg, '1001', 'thread', T)).toBe(a);
    expect(linkRef(cfg, '1002', 'thread', T)).not.toBe(a);
    expect(linkRef(cfg, '1001', 'message', T)).not.toBe(a);
  });
  it('normalizes a thread; refuses a response for another id', () => {
    const msg = (id: string, from: string, subject: string, ms: number, labels = ['INBOX']) => ({ id, threadId: T, labelIds: labels, internalDate: String(ms), snippet: 'a &amp; b',
      payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }] } });
    const raw = { id: T, messages: [msg(T, 'A <a@x.example>', 'Nabídka', 1000), msg('18c3a5e000000004', 'B <b@y.example>', 'Re: Nabídka', 5000)] };
    expect(normalizeItem('thread', raw, T)).toMatchObject({ subject: 'Nabídka', messageCount: 2, date: new Date(5000).toISOString(), snippet: 'a & b', state: 'ok' });
    expect(normalizeItem('thread', raw, '18c3a5e0000000ff')).toBeNull();
    expect(normalizeItem('message', { ...msg(ID, '', '', 1, ['TRASH']), id: ID }, ID)).toMatchObject({ subject: '(bez předmětu)', state: 'trashed' });
  });
});

describe('Gmail API client (caller token, bounded, mapped errors)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('only the configured Gmail base, read-only GET with the caller token, redirect refused', async () => {
    const f = vi.fn(async () => reply(404, { error: { code: 404 } }));
    vi.stubGlobal('fetch', f);
    expect(await getItem(cfg, 'tok', 'message', ID)).toEqual({ ok: false, reason: 'not_found' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${ID}?format=metadata`)).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.redirect).toBe('error');
    expect(await getItem(cfg, 'tok', 'message', '../../etc')).toEqual({ ok: false, reason: 'not_found' });
    expect(f).toHaveBeenCalledTimes(1);   // invalid id never reaches fetch
  });
  it.each([
    [401, {}, 'auth'], [403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }, 'forbidden'],
    [403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 'rate_limited'], [404, {}, 'not_found'], [400, {}, 'not_found'], [429, {}, 'rate_limited'], [503, {}, 'unavailable'],
  ])('HTTP %i -> %s (one retry on 429/5xx)', async (status, body, reason) => {
    const f = vi.fn(async () => reply(status as number, body));
    vi.stubGlobal('fetch', f);
    expect(await getItem(cfg, 'tok', 'message', ID)).toEqual({ ok: false, reason });
    expect(f).toHaveBeenCalledTimes(status === 429 || (status as number) >= 500 ? 2 : 1);
  });
  it('search: dedupes duplicate list ids, skips items deleted between list and get, bounds page size, passes q + pageToken', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      calls.push(u);
      if (u.includes('/messages?')) return reply(200, { messages: [{ id: ID }, { id: ID }, { id: '18c3a5e000000009' }, { id: '../x' }], nextPageToken: '20', resultSizeEstimate: 30 });
      if (u.includes('18c3a5e000000009')) return reply(404, {});
      return reply(200, { id: ID, threadId: ID, internalDate: '1000', payload: { headers: [{ name: 'Subject', value: 'Duplicita' }] } });
    }));
    const r = await search(cfg, 'tok', { kind: 'message', q: 'from:(x)', pageToken: '10', pageSize: 999 });
    expect(r.ok && r.value.items.map((i) => i.subject)).toEqual(['Duplicita']);
    expect(r.ok && r.value.nextPageToken).toBe('20');
    const list = new URL(calls[0]);
    expect(list.searchParams.get('maxResults')).toBe('20');
    expect(list.searchParams.get('q')).toBe('from:(x)');
    expect(list.searchParams.get('pageToken')).toBe('10');
    expect(calls.filter((c) => c.includes(ID)).length).toBe(1);
  });
  it('search: empty mailbox / no results is an empty page, not an error; a list failure is reported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { resultSizeEstimate: 0 })));
    expect(await search(cfg, 'tok', { kind: 'thread', q: '', pageSize: 10 })).toEqual({ ok: true, value: { items: [], nextPageToken: null, estimate: 0 } });
    vi.stubGlobal('fetch', vi.fn(async () => reply(429, {})));
    expect(await search(cfg, 'tok', { kind: 'thread', q: '', pageSize: 10 })).toEqual({ ok: false, reason: 'rate_limited' });
  });
  it('content: plain text with provenance, HTML reduced, oversized response refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { id: ID, threadId: ID, internalDate: '1000', labelIds: ['INBOX'],
      payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: 'Jana <jana@corvane.example>' }, { name: 'Subject', value: 'Nabídka' }], parts: [html('<p>Ahoj<img src="https://t.example/p.gif"></p>')] } })));
    const r = await getContent(cfg, 'tok', 'message', ID);
    expect(r.ok && r.value).toMatchObject({ provider: 'gmail_message', subject: 'Nabídka', messageCount: 1, sharedSender: 'Jana', state: 'ok' });
    expect(r.ok && r.value.messages[0]).toMatchObject({ text: 'Ahoj', fromHtml: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(5 * 1024 * 1024 + 10))));
    expect(await getContent(cfg, 'tok', 'thread', ID)).toEqual({ ok: false, reason: 'too_large' });
  });
  it('Czech error texts exist for every failure', () => {
    for (const k of ['not_found', 'auth', 'rate_limited', 'forbidden', 'unavailable', 'too_large', 'not_owner', 'other_account', 'deleted']) expect((GMAIL_TEXT as Record<string, string>)[k]).toMatch(/\S/);
  });
});
