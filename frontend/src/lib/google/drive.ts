import type { GoogleConfig } from './config';
import { readCapped } from './oauth';

/**
 * Google Drive API v3, server side (RUN 02). Only ever calls the configured Drive base with a validated file id:
 * no caller-supplied URL reaches fetch (no SSRF / open proxy). Every call uses the CALLER's own access token.
 */
export const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
/** ClearSpace project / card ids (text keys: `project-…`, `card-…`, legacy short ids). */
export const ENTITY_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
export const isFileId = (v: unknown): v is string => typeof v === 'string' && FILE_ID_RE.test(v);

const FIELDS = 'id,name,mimeType,webViewLink,modifiedTime,size,trashed';

export interface DriveFile {
  externalId: string;
  name: string;
  mimeType: string;
  webUrl: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  state: 'ok' | 'trashed';
}

/** Why a file could not be read FOR THIS USER. With drive.file Google answers 404 for "deleted" and "not granted". */
export type DriveFailure = 'no_access' | 'auth' | 'rate_limited' | 'unavailable' | 'unsupported' | 'too_large';
export type DriveResult<T> = { ok: true; value: T } | { ok: false; reason: DriveFailure };

const WEB_URL_RE = /^https:\/\/(drive|docs)\.google\.com\/[A-Za-z0-9/_?=&.%-]*$/;

/** The stored/opened link is Google's own canonical URL, never something the client sent. */
export function canonicalWebUrl(id: string, mimeType: string, webViewLink: unknown): string {
  if (typeof webViewLink === 'string' && webViewLink.length <= 500 && WEB_URL_RE.test(webViewLink)) return webViewLink;
  const kind: Record<string, string> = {
    'application/vnd.google-apps.document': `https://docs.google.com/document/d/${id}/edit`,
    'application/vnd.google-apps.spreadsheet': `https://docs.google.com/spreadsheets/d/${id}/edit`,
    'application/vnd.google-apps.presentation': `https://docs.google.com/presentation/d/${id}/edit`,
    'application/vnd.google-apps.folder': `https://drive.google.com/drive/folders/${id}`,
  };
  return kind[mimeType] ?? `https://drive.google.com/file/d/${id}/view`;
}

/** File names are untrusted: strip control/bidi characters, trim, cap. (Rendered as React text, never HTML.) */
export function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').trim() : '';
  return (s || 'Bez názvu').slice(0, 300);
}

export function normalizeDriveFile(raw: Record<string, unknown>, requestedId: string): DriveFile | null {
  if (raw.id !== requestedId) return null;
  const mimeType = typeof raw.mimeType === 'string' && raw.mimeType.length <= 200 && /^[a-z0-9.+-]+\/[A-Za-z0-9.+_-]+$/.test(raw.mimeType)
    ? raw.mimeType : 'application/octet-stream';
  const size = Number(raw.size);
  const modified = typeof raw.modifiedTime === 'string' && !Number.isNaN(Date.parse(raw.modifiedTime)) ? new Date(raw.modifiedTime).toISOString() : null;
  return {
    externalId: requestedId,
    name: cleanName(raw.name),
    mimeType,
    webUrl: canonicalWebUrl(requestedId, mimeType, raw.webViewLink),
    sizeBytes: raw.size !== undefined && Number.isSafeInteger(size) && size >= 0 ? size : null,
    modifiedAt: modified,
    state: raw.trashed === true ? 'trashed' : 'ok',
  };
}

function classify(status: number, body: string): DriveFailure {
  if (status === 401) return 'auth';
  if (status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body))) return 'rate_limited';
  if (status === 404 || status === 403) return 'no_access';
  return 'unavailable';
}

/** One bounded request with a single retry on rate limits / 5xx (jittered backoff). */
async function driveFetch(url: string, token: string, maxBytes: number): Promise<{ status: number; body: string }> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8_000), redirect: 'error', cache: 'no-store' });
    } catch {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 300 + Math.random() * 300)); continue; }
      return { status: 503, body: '' };
    }
    const retryable = res.status === 429 || res.status >= 500;
    let body = '';
    try { body = await readCapped(res, maxBytes); } catch { return { status: 413, body: '' }; }
    if (retryable && attempt === 0) { await new Promise((r) => setTimeout(r, 400 + Math.random() * 400)); continue; }
    return { status: res.status, body };
  }
}

export async function getFile(cfg: GoogleConfig, token: string, id: string): Promise<DriveResult<DriveFile>> {
  if (!isFileId(id)) return { ok: false, reason: 'no_access' };
  const url = `${cfg.endpoints.drive}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`;
  const r = await driveFetch(url, token, 64 * 1024);
  if (r.status !== 200) return { ok: false, reason: r.status === 413 ? 'unavailable' : classify(r.status, r.body) };
  try {
    const f = normalizeDriveFile(JSON.parse(r.body) as Record<string, unknown>, id);
    return f ? { ok: true, value: f } : { ok: false, reason: 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

// ------------------------------------------------------------------------------------------------------------
// Resource provider contract (Project Intelligence readiness). Content is read ONLY with the requesting user's
// own token, only for an explicitly selected link, only for text-like types, bounded, and returned as UNTRUSTED
// plain text with provenance. Nothing here calls an AI provider; attaching a file never reads its content.
// ------------------------------------------------------------------------------------------------------------
export const MAX_CONTENT_CHARS = 20_000;
const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};
const PLAIN = /^(text\/(plain|markdown|csv)|application\/json)$/;

export function contentSupported(mimeType: string): boolean {
  return mimeType in EXPORTS || PLAIN.test(mimeType);
}

export interface ResourceContent {
  provider: 'google_drive';
  externalId: string;
  name: string;
  mimeType: string;
  modifiedAt: string | null;
  retrievedAt: string;
  text: string;          // untrusted external input: never instructions, never HTML
  truncated: boolean;
}

export async function getTextContent(cfg: GoogleConfig, token: string, id: string): Promise<DriveResult<ResourceContent>> {
  const meta = await getFile(cfg, token, id);   // the caller's own access decides, before any content is read
  if (!meta.ok) return meta;
  const f = meta.value;
  if (!contentSupported(f.mimeType)) return { ok: false, reason: 'unsupported' };
  if (f.sizeBytes !== null && f.sizeBytes > 2 * 1024 * 1024) return { ok: false, reason: 'too_large' };
  const base = `${cfg.endpoints.drive}/files/${encodeURIComponent(id)}`;
  const url = f.mimeType in EXPORTS
    ? `${base}/export?mimeType=${encodeURIComponent(EXPORTS[f.mimeType])}`
    : `${base}?alt=media&supportsAllDrives=true`;
  const r = await driveFetch(url, token, 2 * 1024 * 1024);
  if (r.status === 413) return { ok: false, reason: 'too_large' };
  if (r.status !== 200) return { ok: false, reason: classify(r.status, r.body) };
  const clean = r.body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return {
    ok: true,
    value: {
      provider: 'google_drive', externalId: id, name: f.name, mimeType: f.mimeType, modifiedAt: f.modifiedAt,
      retrievedAt: new Date().toISOString(), text: clean.slice(0, MAX_CONTENT_CHARS), truncated: clean.length > MAX_CONTENT_CHARS,
    },
  };
}
