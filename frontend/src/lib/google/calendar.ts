import { createHmac } from 'node:crypto';
import type { GoogleConfig } from './config';
import { gmailFetch } from './gmail';
import { cleanLine } from './mime';

/**
 * Google Calendar API v3, server side (RUN 04), READ-ONLY, the caller's OWN primary calendar only. Paths are built from
 * validated ids (no caller URL reaches fetch); every call uses the CALLER's own access token. There is no insert / update /
 * patch / delete / move / import / watch call anywhere in this code. Responses are trimmed with `fields`, so Google never
 * sends description, location, attendee addresses or conference (Meet) data to the server in the first place.
 */
export const EVENT_ID_RE = /^[A-Za-z0-9_]{5,1024}$/;
export const isEventId = (v: unknown): v is string => typeof v === 'string' && EVENT_ID_RE.test(v);
export const PAGE_TOKEN_RE = /^[A-Za-z0-9_=-]{1,512}$/;
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;
export type CalendarFailure = 'not_found' | 'auth' | 'rate_limited' | 'forbidden' | 'unavailable' | 'too_large';
export type CalendarResult<T> = { ok: true; value: T } | { ok: false; reason: CalendarFailure };

export const CALENDAR_TEXT: Record<CalendarFailure | 'not_owner' | 'other_account' | 'private' | 'deleted' | 'range', string> = {
  not_found: 'Událost v Google Kalendáři už není (byla smazána nebo zrušena), nebo patří k jinému účtu Google.',
  auth: 'Přihlášení ke Google vypršelo. Zkuste to prosím znovu.',
  rate_limited: 'Příliš mnoho požadavků na Google Kalendář. Zkuste to prosím za několik minut.',
  forbidden: 'Google Kalendář přístup odmítl (oprávnění chybí, nebo ho zakázal správce účtu Google Workspace).',
  unavailable: 'Google Kalendář je dočasně nedostupný. Zkuste to prosím později.',
  too_large: 'Odpověď Google Kalendáře je příliš velká. Zkuste kratší období.',
  not_owner: 'Událost může otevřít nebo obnovit jen ten, kdo ji připojil, ze svého Google Kalendáře.',
  other_account: 'Událost byla připojena z jiného účtu Google, než který máte připojený teď.',
  private: 'Soukromou ani důvěrnou událost nelze připojit k projektu. Vidíte ji jen vy ve svém kalendáři.',
  deleted: 'Událost už v Google Kalendáři toho, kdo ji připojil, není (zrušena nebo smazána).',
  range: 'Období musí být platné a nejvýš 42 dní dlouhé.',
};
export const CALENDAR_STATUS: Record<string, number> = { not_found: 404, auth: 409, rate_limited: 429, forbidden: 403, unavailable: 503, too_large: 413 };

/** Opaque, deterministic link key (dedupe per Google account + event); reveals no event id to project members. */
export function linkRef(cfg: GoogleConfig, sub: string, eventId: string): string {
  return createHmac('sha256', cfg.serverSecret).update(`gcal:${sub}:${eventId}`).digest('base64url').slice(0, 40);
}

// ---------------------------------------------------------------- range (E8)
export const MAX_RANGE_DAYS = 42;
/** [from, to) as validated ISO instants, at most 42 days; null when invalid. */
export function parseRange(from: unknown, to: unknown): { from: string; to: string } | null {
  if (typeof from !== 'string' || typeof to !== 'string' || from.length > 40 || to.length > 40) return null;
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
  if (!iso.test(from) || !iso.test(to)) return null;
  const a = Date.parse(from); const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > MAX_RANGE_DAYS * 86_400_000) return null;
  return { from: new Date(a).toISOString(), to: new Date(b).toISOString() };
}

// ---------------------------------------------------------------- transport
function classify(status: number, body: string): CalendarFailure {
  if (status === 401) return 'auth';
  if (status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body))) return 'rate_limited';
  if (status === 404 || status === 410 || status === 400) return 'not_found';
  if (status === 403) return 'forbidden';
  return 'unavailable';
}

async function getJson(cfg: GoogleConfig, token: string, path: string, maxBytes = 1024 * 1024): Promise<CalendarResult<Record<string, unknown>>> {
  const r = await gmailFetch(`${cfg.endpoints.calendar}/calendars/primary/${path}`, token, maxBytes);
  if (r.status === 413) return { ok: false, reason: 'too_large' };
  if (r.status !== 200) return { ok: false, reason: classify(r.status, r.body) };
  try { return { ok: true, value: JSON.parse(r.body) as Record<string, unknown> }; } catch { return { ok: false, reason: 'unavailable' }; }
}

// ---------------------------------------------------------------- normalization
interface RawTime { date?: unknown; dateTime?: unknown; timeZone?: unknown }
interface RawEvent {
  id?: unknown; status?: unknown; summary?: unknown; start?: RawTime; end?: RawTime; recurringEventId?: unknown; originalStartTime?: RawTime;
  visibility?: unknown; organizer?: { displayName?: unknown; email?: unknown }; attendees?: unknown; htmlLink?: unknown; updated?: unknown; eventType?: unknown;
}
/** Only these fields are ever requested from Google (no description, location, attendee e-mails, conference data, attachments). */
const EVENT_FIELDS = 'id,status,summary,start,end,recurringEventId,originalStartTime,visibility,organizer(displayName,email),attendees(responseStatus),htmlLink,updated,eventType';

/** The owner's own view of one event. Only `sharedFields()` of it may ever be stored for project members. */
export interface CalendarEvent {
  id: string;
  recurringEventId: string | null;
  title: string;
  start: string;           // ISO instant; all-day: the date at 00:00 UTC (render as a date, no zone conversion)
  end: string;             // exclusive (all-day: the day AFTER the last day, as Google sends it)
  allDay: boolean;
  timeZone: string | null; // the event's own zone (label when it differs from the viewer's)
  recurring: boolean;      // an occurrence of a series (incl. a modified one)
  modified: boolean;       // E2: a moved / edited occurrence (originalStartTime differs from start)
  attendees: number;
  organizer: string;       // display name, else only the domain
  private: boolean;        // visibility private / confidential: never linkable
  state: 'ok' | 'deleted';
  updated: string | null;
  htmlLink: string | null; // owner only, never stored
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function instant(t: RawTime | undefined): { iso: string; allDay: boolean } | null {
  if (!t) return null;
  if (typeof t.dateTime === 'string') {
    const n = Date.parse(t.dateTime);
    return Number.isFinite(n) ? { iso: new Date(n).toISOString(), allDay: false } : null;
  }
  if (typeof t.date === 'string' && DAY_RE.test(t.date)) {
    const n = Date.parse(`${t.date}T00:00:00Z`);
    return Number.isFinite(n) ? { iso: new Date(n).toISOString(), allDay: true } : null;
  }
  return null;
}
/** Organizer label members may see: display name, or only the domain (never the full address). */
export function sharedOrganizer(o: RawEvent['organizer']): string {
  const name = cleanLine(o?.displayName, 120, '');
  if (name) return name;
  const email = typeof o?.email === 'string' ? o.email.toLowerCase() : '';
  const domain = /^[^\s@]+@([a-z0-9.-]{1,200})$/.exec(email)?.[1];
  // group calendars have addresses like …@group.calendar.google.com: still only a domain
  return domain ? `@${domain}`.slice(0, 200) : 'Neznámý organizátor';
}
/** Google's event page link, accepted only on Google's own hosts (owner only; never stored). */
export function safeHtmlLink(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && (u.hostname === 'www.google.com' || u.hostname === 'calendar.google.com') ? u.toString() : null;
  } catch { return null; }
}

export function normalizeEvent(raw: RawEvent, requestedId?: string): CalendarEvent | null {
  if (!isEventId(raw.id) || (requestedId !== undefined && raw.id !== requestedId)) return null;   // never trust a response for another id
  const cancelled = raw.status === 'cancelled';
  const s = instant(raw.start); const e = instant(raw.end);
  if (!cancelled && (!s || !e || s.allDay !== e.allDay || Date.parse(e.iso) < Date.parse(s.iso))) return null;
  const tz = typeof raw.start?.timeZone === 'string' && raw.start.timeZone.length <= 64 && TZ_RE.test(raw.start.timeZone) ? raw.start.timeZone : null;
  const orig = instant(raw.originalStartTime);
  const updated = typeof raw.updated === 'string' && Number.isFinite(Date.parse(raw.updated)) ? new Date(Date.parse(raw.updated)).toISOString() : null;
  return {
    id: raw.id,
    recurringEventId: isEventId(raw.recurringEventId) ? raw.recurringEventId : null,
    title: cleanLine(raw.summary, 300, '(bez názvu)'),
    start: s?.iso ?? new Date(0).toISOString(),
    end: e?.iso ?? s?.iso ?? new Date(0).toISOString(),
    allDay: s?.allDay ?? false,
    timeZone: tz,
    recurring: isEventId(raw.recurringEventId),
    modified: Boolean(orig && s && orig.iso !== s.iso),
    attendees: Array.isArray(raw.attendees) ? Math.min(raw.attendees.length, 100_000) : 0,
    organizer: sharedOrganizer(raw.organizer),
    private: raw.visibility === 'private' || raw.visibility === 'confidential',
    state: cancelled ? 'deleted' : 'ok',
    updated,
    htmlLink: safeHtmlLink(raw.htmlLink),
  };
}

/** What project members may see about a linked event (exactly the shared columns). */
export function sharedFields(ev: CalendarEvent) {
  return {
    p_title: ev.title, p_start: ev.start, p_end: ev.end, p_all_day: ev.allDay, p_time_zone: ev.timeZone, p_recurring: ev.recurring,
    p_attendees: ev.attendees, p_organizer: ev.organizer, p_updated: ev.updated, p_state: ev.state,
  };
}

// ---------------------------------------------------------------- API calls
/** One event of the caller's primary calendar. Cancelled / gone = state 'deleted' (not a failure). */
export async function getEvent(cfg: GoogleConfig, token: string, id: string): Promise<CalendarResult<CalendarEvent | { id: string; state: 'deleted' }>> {
  if (!isEventId(id)) return { ok: false, reason: 'not_found' };
  const r = await getJson(cfg, token, `events/${id}?fields=${encodeURIComponent(EVENT_FIELDS)}`);
  if (!r.ok) return r.reason === 'not_found' ? { ok: true, value: { id, state: 'deleted' } } : r;
  const ev = normalizeEvent(r.value as RawEvent, id);
  if (!ev) return { ok: false, reason: 'unavailable' };
  return { ok: true, value: ev };
}

export interface EventPage { items: CalendarEvent[]; nextPageToken: string | null }

/**
 * One bounded page of the caller's own events overlapping [from, to) (Google: timeMin is exclusive for the END,
 * timeMax exclusive for the START), occurrences expanded, ordered by start. Cancelled occurrences are not listed by
 * Google here; working-location markers are skipped (not meetings). Duplicate ids are kept once.
 */
export async function listEvents(cfg: GoogleConfig, token: string, p: { from: string; to: string; q?: string; pageToken?: string | null; pageSize: number }): Promise<CalendarResult<EventPage>> {
  const qs = new URLSearchParams({
    timeMin: p.from, timeMax: p.to, singleEvents: 'true', orderBy: 'startTime',
    maxResults: String(Math.min(Math.max(p.pageSize, 1), 250)),
    fields: `items(${EVENT_FIELDS}),nextPageToken`,
  });
  const q = cleanLine(p.q ?? '', 200, '');
  if (q) qs.set('q', q);
  if (p.pageToken) qs.set('pageToken', p.pageToken);
  const r = await getJson(cfg, token, `events?${qs.toString()}`, 2 * 1024 * 1024);
  if (!r.ok) return r;
  const raw = (Array.isArray(r.value.items) ? r.value.items : []) as RawEvent[];
  const seen = new Set<string>();
  const items: CalendarEvent[] = [];
  for (const x of raw) {
    if (x?.eventType === 'workingLocation') continue;
    const ev = normalizeEvent(x);
    if (!ev || ev.state !== 'ok' || seen.has(ev.id)) continue;
    seen.add(ev.id);
    items.push(ev);
  }
  const next = typeof r.value.nextPageToken === 'string' && PAGE_TOKEN_RE.test(r.value.nextPageToken) ? r.value.nextPageToken : null;
  return { ok: true, value: { items, nextPageToken: next } };
}
