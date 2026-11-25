/**
 * Gmail message payload -> plain text (RUN 03). Everything here is UNTRUSTED external input. HTML is never rendered: it
 * is reduced to text on the server (no tags, no attributes, no URLs fetched), so remote images / tracking pixels, scripts,
 * styles and forms cannot reach the browser at all. Bounded in depth, part count, input size and output length; linear
 * time (no backtracking regexes over attacker-controlled spans).
 */
export interface GmailHeader { name?: string; value?: string }
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface AttachmentMeta { name: string; mimeType: string; size: number | null }
export interface ExtractedText { text: string; fromHtml: boolean; truncated: boolean; missing: boolean; attachments: AttachmentMeta[] }

export const MAX_TEXT_CHARS = 20_000;
const MAX_HTML_INPUT = 512 * 1024;
const MAX_DEPTH = 12;
const MAX_PARTS = 200;
const MAX_ATTACHMENTS = 50;

export function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const n = name.toLowerCase();
  return headers?.find((h) => typeof h?.name === 'string' && h.name.toLowerCase() === n && typeof h.value === 'string')?.value;
}

/** Control and bidi-override characters removed; newlines and tabs kept. */
export function stripControl(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '');
}

/** One-line untrusted text (subject, names, file names). */
export function cleanLine(raw: unknown, max: number, fallback: string): string {
  const s = typeof raw === 'string' ? stripControl(raw).replace(/[\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim() : '';
  return (s || fallback).slice(0, max);
}

export function charsetOf(contentType: string | undefined): string | undefined {
  const m = /charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})"?/i.exec(contentType ?? '');
  return m?.[1].toLowerCase();
}

/** base64url body -> string in the part's charset; unknown or invalid charsets fall back to UTF-8 with replacement chars. */
export function decodeBody(data: string, charset?: string): string {
  const bytes = Buffer.from(data, 'base64url');
  let dec: TextDecoder;
  try { dec = new TextDecoder(charset && charset !== 'us-ascii' ? charset : 'utf-8', { fatal: false }); } catch { dec = new TextDecoder('utf-8', { fatal: false }); }
  return stripControl(dec.decode(bytes));
}

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»',
  bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', euro: '€', copy: '©', reg: '®', trade: '™', shy: '',
  zwnj: '', zwj: '', bull: '•', middot: '·', deg: '°', times: '×',
};
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (m, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || cp < 0x20 && cp !== 9 && cp !== 10) return '';
    return String.fromCodePoint(cp);
  });
}

const DROP_BLOCKS = ['script', 'style', 'head', 'title', 'template', 'noscript', 'svg', 'object', 'iframe', 'math', 'xml'];
const BREAKS = /^(br|p|div|li|tr|h[1-6]|blockquote|section|article|table|ul|ol|hr|pre|header|footer)$/;

/**
 * HTML -> readable text. A single forward scan: drops comments and whole non-content elements (an unclosed one drops the
 * rest, as a browser would), turns block boundaries into line breaks, keeps only text. Link targets and image sources are
 * discarded (no phishing URLs, nothing remote is ever loaded).
 */
export function htmlToText(input: string): string {
  const html = input.length > MAX_HTML_INPUT ? input.slice(0, MAX_HTML_INPUT) : input;
  const lower = html.toLowerCase();
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break;
    const m = /^<\/?\s*([a-z][a-z0-9]*)/.exec(lower.slice(lt, Math.min(gt + 1, lt + 40)));
    const tag = m?.[1] ?? '';
    const closing = lower[lt + 1] === '/';
    if (!closing && DROP_BLOCKS.includes(tag)) {
      const end = lower.indexOf(`</${tag}`, gt + 1);
      if (end < 0) break;
      const endGt = html.indexOf('>', end);
      i = endGt < 0 ? html.length : endGt + 1;
      out += ' ';
      continue;
    }
    if (BREAKS.test(tag)) out += tag === 'li' && !closing ? '\n• ' : '\n';
    i = gt + 1;
  }
  return decodeEntities(out)
    .replace(/[ \t ]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isAttachment(p: GmailPart): boolean {
  const disp = header(p.headers, 'Content-Disposition') ?? '';
  return Boolean(p.filename) || /^\s*attachment/i.test(disp) || (Boolean(p.body?.attachmentId) && !/^text\/(plain|html)$/i.test(p.mimeType ?? ''));
}

/** The readable text of one message payload (plain text preferred, else HTML reduced to text) + attachment METADATA only. */
export function extractText(payload: GmailPart | undefined): ExtractedText {
  let plain: GmailPart | undefined;
  let html: GmailPart | undefined;
  const attachments: AttachmentMeta[] = [];
  let seen = 0;
  const walk = (p: GmailPart | undefined, depth: number) => {
    if (!p || depth > MAX_DEPTH || ++seen > MAX_PARTS) return;
    const mime = (p.mimeType ?? '').toLowerCase();
    if (isAttachment(p)) {
      if (attachments.length < MAX_ATTACHMENTS) {
        const size = Number(p.body?.size);
        attachments.push({ name: cleanLine(p.filename, 200, 'příloha bez názvu'), mimeType: /^[a-z0-9.+-]+\/[a-z0-9.+_-]+$/i.test(mime) ? mime.slice(0, 100) : 'application/octet-stream', size: Number.isSafeInteger(size) && size >= 0 ? size : null });
      }
      return;
    }
    if (mime === 'text/plain' && !plain) plain = p;
    else if (mime === 'text/html' && !html) html = p;
    for (const c of Array.isArray(p.parts) ? p.parts : []) walk(c, depth + 1);
  };
  walk(payload, 0);
  const pick = plain?.body?.data ? plain : html?.body?.data ? html : undefined;
  if (!pick) return { text: '', fromHtml: false, truncated: false, missing: true, attachments };
  const raw = decodeBody(pick.body!.data!, charsetOf(header(pick.headers, 'Content-Type')));
  const fromHtml = pick === html;
  const text = (fromHtml ? htmlToText(raw) : raw.replace(/\n{4,}/g, '\n\n\n').trim());
  return { text: text.slice(0, MAX_TEXT_CHARS), fromHtml, truncated: text.length > MAX_TEXT_CHARS, missing: false, attachments };
}
