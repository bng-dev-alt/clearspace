import { createHmac } from 'node:crypto';
import type { GoogleConfig } from './config';
import { readCapped } from './oauth';
import { cleanLine, decodeEntities, extractText, header, type AttachmentMeta, type GmailPart } from './mime';

/**
 * Gmail API v1, server side (RUN 03), read-only. Only ever calls the configured Gmail base, path built from validated
 * ids (no caller URL reaches fetch). Every call uses the CALLER's own access token; one user's token never reads another
 * user's mailbox. Nothing here modifies a mailbox (no send / modify / trash / label call exists).
 */
export const GMAIL_ID_RE = /^[0-9a-f]{6,32}$/;
export const isGmailId = (v: unknown): v is string => typeof v === 'string' && GMAIL_ID_RE.test(v);
export type GmailKind = 'message' | 'thread';
export type GmailFailure = 'not_found' | 'auth' | 'rate_limited' | 'forbidden' | 'unavailable' | 'too_large';
export type GmailResult<T> = { ok: true; value: T } | { ok: false; reason: GmailFailure };

export const GMAIL_TEXT: Record<GmailFailure | 'not_owner' | 'other_account' | 'deleted' | 'trashed', string> = {
  not_found: 'E-mail už ve schránce není (byl smazán), nebo patří k jinému účtu Google.',
  auth: 'Přihlášení ke Google vypršelo. Zkuste to prosím znovu.',
  rate_limited: 'Příliš mnoho požadavků na Gmail. Zkuste to prosím za několik minut.',
  forbidden: 'Gmail přístup odmítl (oprávnění chybí, nebo ho zakázal správce účtu Google Workspace).',
  unavailable: 'Gmail je dočasně nedostupný. Zkuste to prosím později.',
  too_large: 'E-mail je pro náhled příliš velký. Otevřete ho v Gmailu.',
  not_owner: 'Obsah e-mailu může zobrazit jen ten, kdo ho připojil, ze své vlastní schránky.',
  other_account: 'E-mail byl připojen z jiného účtu Google, než který máte připojený teď.',
  deleted: 'E-mail už ve schránce toho, kdo ho připojil, není.',
  trashed: 'E-mail je v koši Gmailu.',
};

/** Opaque, deterministic link key (dedupe per Google account + item); reveals no Gmail id to project members. */
export function linkRef(cfg: GoogleConfig, sub: string, kind: GmailKind, id: string): string {
  return createHmac('sha256', cfg.serverSecret).update(`gmail:${kind}:${sub}:${id}`).digest('base64url').slice(0, 40);
}

/** Opens the thread in the OWNER's Gmail (account 0 of their browser). Undocumented-but-stable Gmail URL form; best effort. */
export const gmailWebUrl = (threadId: string) => (isGmailId(threadId) ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null);

// ---------------------------------------------------------------- search query
export interface SearchInput { text?: unknown; from?: unknown; subject?: unknown; after?: unknown; before?: unknown }
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const term = (v: unknown, max: number) => (typeof v === 'string' ? cleanLine(v, max, '').replace(/[(){}"\\]/g, ' ').replace(/\s{2,}/g, ' ').trim() : '');
function day(v: unknown): string | null {
  const m = typeof v === 'string' ? DATE_RE.exec(v) : null;
  if (!m || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return null;
  return `${m[1]}/${m[2]}/${m[3]}`;
}
/** Gmail search string from validated fields. Grouping characters are removed from values, so a value cannot add operators. */
export function buildQuery(i: SearchInput): string {
  const parts: string[] = [];
  const text = term(i.text, 200);
  const from = term(i.from, 120);
  const subject = term(i.subject, 160);
  if (text) parts.push(text);
  if (from) parts.push(`from:(${from})`);
  if (subject) parts.push(`subject:(${subject})`);
  const a = day(i.after); const b = day(i.before);
  if (a) parts.push(`after:${a}`);
  if (b) parts.push(`before:${b}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- transport
function classify(status: number, body: string): GmailFailure {
  if (status === 401) return 'auth';
  if (status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded|concurrent/i.test(body))) return 'rate_limited';
  if (status === 404 || status === 400) return 'not_found';
  if (status === 403) return 'forbidden';
  return 'unavailable';
}

/** Bounded GET (timeout, one jittered retry on network/429/5xx, size cap, no redirects). RUN 04: also used by calendar.ts. */
export async function gmailFetch(url: string, token: string, maxBytes: number): Promise<{ status: number; body: string }> {
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

async function getJson(cfg: GoogleConfig, token: string, path: string, maxBytes = 256 * 1024): Promise<GmailResult<Record<string, unknown>>> {
  const r = await gmailFetch(`${cfg.endpoints.gmail}/users/me/${path}`, token, maxBytes);
  if (r.status === 413) return { ok: false, reason: 'too_large' };
  if (r.status !== 200) return { ok: false, reason: classify(r.status, r.body) };
  try { return { ok: true, value: JSON.parse(r.body) as Record<string, unknown> }; } catch { return { ok: false, reason: 'unavailable' }; }
}

// ---------------------------------------------------------------- normalization
interface RawMessage { id?: unknown; threadId?: unknown; labelIds?: unknown; internalDate?: unknown; snippet?: unknown; payload?: GmailPart }

/** "Jan Novák" <jan@firma.cz> -> { name, address, domain }. Untrusted; never rendered as HTML. */
export function parseFrom(raw: string | undefined): { name: string; address: string; domain: string } {
  const v = cleanLine(raw, 400, '');
  const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(v);
  const address = (m ? m[2] : /^[^\s<>]+@[^\s<>]+$/.test(v) ? v : '').toLowerCase().slice(0, 254);
  const name = cleanLine((m ? m[1] : address ? '' : v).replace(/^"+|"+$/g, ''), 120, '');
  return { name, address, domain: address.split('@')[1] ?? '' };
}
/** What project members may see about the sender: the display name, or only the domain (never the full address). */
export const sharedSender = (f: { name: string; domain: string }) => (f.name || (f.domain ? `@${f.domain}` : 'Neznámý odesílatel')).slice(0, 200);

const msDate = (m: RawMessage, dateHeader?: string): string | null => {
  const n = Number(m.internalDate);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  const d = Date.parse(dateHeader ?? '');
  return Number.isNaN(d) ? null : new Date(d).toISOString();
};
const labels = (m: RawMessage) => (Array.isArray(m.labelIds) ? m.labelIds.filter((x): x is string => typeof x === 'string') : []);

/** One search result / link candidate: owner's own view (full sender, snippet). Only `shared` fields are ever stored. */
export interface GmailItem {
  kind: GmailKind;
  id: string;
  threadId: string;
  subject: string;
  from: { name: string; address: string; domain: string };
  date: string | null;
  messageCount: number;
  snippet: string;
  state: 'ok' | 'trashed';
}

function normalizeMessage(m: RawMessage): Omit<GmailItem, 'kind' | 'messageCount'> | null {
  if (!isGmailId(m.id) || !isGmailId(m.threadId)) return null;
  const h = m.payload?.headers;
  return {
    id: m.id,
    threadId: m.threadId,
    subject: cleanLine(header(h, 'Subject'), 300, '(bez předmětu)'),
    from: parseFrom(header(h, 'From')),
    date: msDate(m, header(h, 'Date')),
    snippet: cleanLine(decodeEntities(typeof m.snippet === 'string' ? m.snippet : ''), 240, ''),
    state: labels(m).includes('TRASH') ? 'trashed' : 'ok',
  };
}

export function normalizeItem(kind: GmailKind, raw: Record<string, unknown>, requestedId: string): GmailItem | null {
  if (raw.id !== requestedId) return null;   // never trust a response for another id
  if (kind === 'message') {
    const n = normalizeMessage(raw as RawMessage);
    return n ? { kind, ...n, messageCount: 1 } : null;
  }
  const msgs = (Array.isArray(raw.messages) ? raw.messages : []) as RawMessage[];
  const norm = msgs.map(normalizeMessage).filter((x): x is NonNullable<typeof x> => x !== null);
  if (!norm.length) return null;
  const first = norm[0]; const last = norm[norm.length - 1];
  return {
    kind, id: requestedId, threadId: requestedId, subject: first.subject, from: first.from, date: last.date,
    messageCount: Math.min(norm.length, 10_000), snippet: last.snippet,
    state: norm.every((x) => x.state === 'trashed') ? 'trashed' : 'ok',
  };
}

// ---------------------------------------------------------------- API calls
const META = 'format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';

export async function getItem(cfg: GoogleConfig, token: string, kind: GmailKind, id: string): Promise<GmailResult<GmailItem>> {
  if (!isGmailId(id)) return { ok: false, reason: 'not_found' };
  const r = await getJson(cfg, token, `${kind === 'thread' ? 'threads' : 'messages'}/${id}?${META}`, 1024 * 1024);
  if (!r.ok) return r;
  const item = normalizeItem(kind, r.value, id);
  return item ? { ok: true, value: item } : { ok: false, reason: 'unavailable' };
}

export interface SearchPage { items: GmailItem[]; nextPageToken: string | null; estimate: number | null }
export const PAGE_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** One bounded page: list ids (threads or messages) for `q`, then their metadata (4 at a time). Deleted-in-between items are skipped. */
export async function search(cfg: GoogleConfig, token: string, p: { kind: GmailKind; q: string; pageToken?: string | null; pageSize: number }): Promise<GmailResult<SearchPage>> {
  const qs = new URLSearchParams({ maxResults: String(Math.min(Math.max(p.pageSize, 1), 20)) });
  if (p.q) qs.set('q', p.q);
  if (p.pageToken) qs.set('pageToken', p.pageToken);
  const list = await getJson(cfg, token, `${p.kind === 'thread' ? 'threads' : 'messages'}?${qs.toString()}`);
  if (!list.ok) return list;
  const arr = (Array.isArray(list.value[p.kind === 'thread' ? 'threads' : 'messages']) ? list.value[p.kind === 'thread' ? 'threads' : 'messages'] : []) as { id?: unknown }[];
  const ids = [...new Set(arr.map((x) => x?.id).filter(isGmailId))].slice(0, 20);
  const items: (GmailItem | null)[] = new Array(ids.length).fill(null);
  let failure: GmailFailure | null = null;
  const queue = ids.map((id, i) => ({ id, i }));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const r = await getItem(cfg, token, p.kind, job.id);
      if (r.ok) items[job.i] = r.value;
      else if (r.reason !== 'not_found') failure = failure ?? r.reason;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (failure && !items.some(Boolean)) return { ok: false, reason: failure };
  const next = typeof list.value.nextPageToken === 'string' && PAGE_TOKEN_RE.test(list.value.nextPageToken) ? list.value.nextPageToken : null;
  const est = Number(list.value.resultSizeEstimate);
  return { ok: true, value: { items: items.filter((x): x is GmailItem => x !== null), nextPageToken: next, estimate: Number.isFinite(est) ? est : null } };
}

// ---------------------------------------------------------------- content (owner preview; resource-provider contract)
export const MAX_THREAD_MESSAGES = 20;
export interface PreviewMessage { from: { name: string; address: string }; date: string | null; subject: string; text: string; fromHtml: boolean; truncated: boolean; missing: boolean; attachments: AttachmentMeta[] }
export interface GmailContent {
  provider: 'gmail_message' | 'gmail_thread';
  subject: string;
  retrievedAt: string;
  messages: PreviewMessage[];     // UNTRUSTED external text, oldest first (latest MAX_THREAD_MESSAGES of a thread)
  omittedMessages: number;
  state: 'ok' | 'trashed';
  attachmentCount: number;
  messageCount: number;
  sharedSender: string;
  date: string | null;
}

export async function getContent(cfg: GoogleConfig, token: string, kind: GmailKind, id: string): Promise<GmailResult<GmailContent>> {
  if (!isGmailId(id)) return { ok: false, reason: 'not_found' };
  const r = await getJson(cfg, token, `${kind === 'thread' ? 'threads' : 'messages'}/${id}?format=full`, 5 * 1024 * 1024);
  if (!r.ok) return r;
  if (r.value.id !== id) return { ok: false, reason: 'unavailable' };
  const raws = (kind === 'thread' ? (Array.isArray(r.value.messages) ? r.value.messages : []) : [r.value]) as RawMessage[];
  const all = raws.map((m) => ({ m, n: normalizeMessage(m) })).filter((x) => x.n !== null);
  if (!all.length) return { ok: false, reason: 'unavailable' };
  const shown = all.slice(-MAX_THREAD_MESSAGES);
  const messages = shown.map(({ m, n }) => {
    const t = extractText(m.payload);
    return { from: { name: n!.from.name, address: n!.from.address }, date: n!.date, subject: n!.subject, text: t.text, fromHtml: t.fromHtml, truncated: t.truncated, missing: t.missing, attachments: t.attachments };
  });
  const first = all[0].n!;
  return {
    ok: true,
    value: {
      provider: kind === 'thread' ? 'gmail_thread' : 'gmail_message',
      subject: first.subject,
      retrievedAt: new Date().toISOString(),
      messages,
      omittedMessages: all.length - shown.length,
      state: all.every((x) => x.n!.state === 'trashed') ? 'trashed' : 'ok',
      attachmentCount: Math.min(messages.reduce((a, x) => a + x.attachments.length, 0), 10_000),
      messageCount: all.length,
      sharedSender: sharedSender(first.from),
      date: all[all.length - 1].n!.date,
    },
  };
}
