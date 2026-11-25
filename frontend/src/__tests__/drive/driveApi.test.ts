import { describe, it, expect, vi, afterEach } from 'vitest';
import { canonicalWebUrl, cleanName, normalizeDriveFile, isFileId, getFile, getTextContent, contentSupported } from '../../lib/google/drive';
import { googleConfig } from '../../lib/google/config';
import { fileKind, fileIconKind, safeDriveUrl, ACCESS_TEXT } from '../../lib/google/labels';
import { describeActivity } from '../../lib/collab/activityText';

const cfg = (() => {
  const c = googleConfig({ GOOGLE_OAUTH_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 's', GOOGLE_SERVER_SECRET: 'g'.repeat(40),
    GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), GOOGLE_PICKER_API_KEY: 'AIzaTestKey_123456', GOOGLE_CLOUD_PROJECT_NUMBER: '1234567', APP_BASE_URL: 'https://c.example' } as unknown as NodeJS.ProcessEnv);
  if (!c.enabled) throw new Error(c.reason);
  return c;
})();
const ID = 'abcDEF0123456789_-';

describe('Drive metadata normalization', () => {
  it('validates file ids (no URLs, paths or injection)', () => {
    expect(isFileId(ID)).toBe(true);
    for (const bad of ['http://169.254.169.254/x', '../../etc', 'a b', 'short', '', 42, null]) expect(isFileId(bad)).toBe(false);
  });
  it('keeps only canonical Google URLs; anything else becomes the canonical one', () => {
    expect(canonicalWebUrl(ID, 'application/pdf', `https://drive.google.com/file/d/${ID}/view?usp=drivesdk`)).toContain('drive.google.com');
    expect(canonicalWebUrl(ID, 'application/pdf', 'javascript:alert(1)')).toBe(`https://drive.google.com/file/d/${ID}/view`);
    expect(canonicalWebUrl(ID, 'application/pdf', 'https://drive.google.com.evil.example/x')).toBe(`https://drive.google.com/file/d/${ID}/view`);
    expect(canonicalWebUrl(ID, 'application/vnd.google-apps.document', undefined)).toBe(`https://docs.google.com/document/d/${ID}/edit`);
    expect(safeDriveUrl('https://evil.example')).toBeNull();
    expect(safeDriveUrl('https://docs.google.com/document/d/x/edit')).not.toBeNull();
  });
  it('names are untrusted: control and bidi characters stripped, length capped, markup kept as text', () => {
    expect(cleanName('<img src=x onerror=alert(1)>‮fdp.exe\u0000')).toBe('<img src=x onerror=alert(1)>fdp.exe');
    expect(cleanName('x'.repeat(500))).toHaveLength(300);
    expect(cleanName('')).toBe('Bez názvu');
  });
  it('normalizes a Drive file and refuses a response for another id', () => {
    const f = normalizeDriveFile({ id: ID, name: 'Rozpočet', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-11-20T09:30:00Z', trashed: true }, ID);
    expect(f).toMatchObject({ name: 'Rozpočet', state: 'trashed', sizeBytes: null, modifiedAt: '2026-11-20T09:30:00.000Z' });
    expect(normalizeDriveFile({ id: 'otherId123456' }, ID)).toBeNull();
    expect(normalizeDriveFile({ id: ID, mimeType: 'text/html"><script>' }, ID)?.mimeType).toBe('application/octet-stream');
  });
  it('Czech labels and supported preview types', () => {
    expect(fileKind('application/vnd.google-apps.document')).toBe('Dokument Google');
    expect(fileKind('application/x-unknown')).toBe('Soubor');
    expect(fileIconKind('application/vnd.google-apps.presentation')).toBe('slides');
    expect(contentSupported('application/vnd.google-apps.document')).toBe(true);
    expect(contentSupported('application/pdf')).toBe(false);
    expect(ACCESS_TEXT.no_access).toMatch(/^Přístup k souboru není dostupný/);
  });
});

describe('Drive API client', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  it('calls only the configured Drive base with the caller token and maps errors per user', async () => {
    const f = vi.fn(async () => reply(404, { error: { code: 404 } }));
    vi.stubGlobal('fetch', f);
    expect(await getFile(cfg, 'tok', ID)).toEqual({ ok: false, reason: 'no_access' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith(`https://www.googleapis.com/drive/v3/files/${ID}?`)).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.redirect).toBe('error');
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, {})));
    expect(await getFile(cfg, 'tok', ID)).toEqual({ ok: false, reason: 'auth' });
    vi.stubGlobal('fetch', vi.fn(async () => reply(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } })));
    expect(await getFile(cfg, 'tok', ID)).toEqual({ ok: false, reason: 'rate_limited' });
  });
  it('an invalid id never reaches the network', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await getFile(cfg, 'tok', 'http://169.254.169.254')).toEqual({ ok: false, reason: 'no_access' });
    expect(f).not.toHaveBeenCalled();
  });
  it('retries once on 429/5xx, then succeeds', async () => {
    const f = vi.fn().mockResolvedValueOnce(reply(503, {})).mockResolvedValueOnce(reply(200, { id: ID, name: 'X', mimeType: 'text/plain' }));
    vi.stubGlobal('fetch', f);
    expect((await getFile(cfg, 'tok', ID)).ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('text content: metadata first (access gate), export for Google Docs, bounded and cleaned', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(reply(200, { id: ID, name: 'Zápis', mimeType: 'application/vnd.google-apps.document' }))
      .mockResolvedValueOnce(reply(200, 'Ahoj\u0007 světe'));
    vi.stubGlobal('fetch', f);
    const r = await getTextContent(cfg, 'tok', ID);
    expect(r.ok && r.value.text).toBe('Ahoj světe');
    expect((f.mock.calls[1] as unknown as [string])[0]).toContain('/export?mimeType=text%2Fplain');
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { id: ID, name: 'a.pdf', mimeType: 'application/pdf' })));
    expect(await getTextContent(cfg, 'tok', ID)).toEqual({ ok: false, reason: 'unsupported' });
  });
});

describe('timeline texts for Drive events', () => {
  const base = { id: 'e', projectId: 'p', actorName: 'Eva', entityType: 'task', createdAt: new Date().toISOString() };
  it('project and task links, both directions, in Czech', () => {
    expect(describeActivity({ ...base, actionType: 'drive_file_linked', details: { name: 'Rozpočet' } })).toEqual({ text: 'připojil(a) k projektu soubor z Disku „Rozpočet"', kind: 'file' });
    expect(describeActivity({ ...base, actionType: 'drive_file_linked', details: { name: 'Rozpočet', title: 'Smlouva' } }).text).toBe('připojil(a) soubor z Disku „Rozpočet" k úkolu „Smlouva"');
    expect(describeActivity({ ...base, actionType: 'drive_file_unlinked', details: { name: 'Rozpočet' } }).text).toBe('odebral(a) z projektu soubor z Disku „Rozpočet"');
  });
});
