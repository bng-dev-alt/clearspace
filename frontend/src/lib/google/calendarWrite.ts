import type { GoogleConfig } from './config';
import { readCapped } from './oauth';
import { normalizeEvent, type CalendarEvent, type CalendarFailure, type CalendarResult } from './calendar';

/**
 * RUN 10 – zápis do Google Kalendáře pro plánování porad (scope calendar.events.owned, služba 'meetings'). Jen tři operace na
 * HLAVNÍM kalendáři uživatele: vytvořit událost (volitelně s Google Meet a pozvánkami), upravit čas/název/hosty, zrušit.
 * Odkaz na Meet se bere VÝHRADNĚ z odpovědi Googlu (conferenceData / hangoutLink); ClearSpace žádný odkaz nevymýšlí.
 * Idempotence: id události = id porady bez pomlček (base32hex podmnožina) -> opakování po výpadku vrátí 409 a událost se dočte,
 * nikdy nevznikne druhá událost ani druhé pozvánky.
 */

export const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}$/;
export const eventIdForMeeting = (meetingId: string) => meetingId.toLowerCase().replace(/-/g, '');

export interface NewEventInput {
  meetingId: string;
  title: string;
  description: string | null;
  start: string;
  end: string;
  timeZone: string;
  attendees: string[];
  withMeet: boolean;
  /** true = Google pošle pozvánky e-mailem (výslovná volba organizátora), false = událost bez e-mailů. */
  sendInvites: boolean;
}

export interface CreatedEvent { event: CalendarEvent; meetUrl: string | null; meetStatus: 'success' | 'pending' | 'failure' | 'none'; duplicate: boolean }

function classify(status: number, body: string): CalendarFailure {
  if (status === 401) return 'auth';
  if (status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body))) return 'rate_limited';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 403) return 'forbidden';
  return 'unavailable';
}

async function call(cfg: GoogleConfig, token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(`${cfg.endpoints.calendar}/calendars/primary/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      cache: 'no-store',
    });
    return { status: res.status, body: await readCapped(res, 256 * 1024).catch(() => '') };
  } catch {
    return { status: 599, body: '' }; // network / timeout: the outcome of a write is UNKNOWN -> callers re-read by the fixed id
  }
}

/** Meet z odpovědi Googlu: jen platný tvar meet.google.com, jinak null (stav pending/failure se ukáže uživateli). */
export function meetFrom(raw: Record<string, unknown>): { url: string | null; status: CreatedEvent['meetStatus'] } {
  const cd = raw.conferenceData as { createRequest?: { status?: { statusCode?: unknown } }; entryPoints?: { entryPointType?: unknown; uri?: unknown }[] } | undefined;
  const code = cd?.createRequest?.status?.statusCode;
  const entry = cd?.entryPoints?.find((e) => e?.entryPointType === 'video')?.uri;
  const candidate = typeof entry === 'string' ? entry : typeof raw.hangoutLink === 'string' ? raw.hangoutLink : null;
  const url = candidate && MEET_URL_RE.test(candidate) ? candidate : null;
  const status = url ? 'success' : code === 'pending' ? 'pending' : code === 'failure' ? 'failure' : cd ? 'failure' : 'none';
  return { url, status };
}

const parse = (b: string): Record<string, unknown> | null => { try { return JSON.parse(b) as Record<string, unknown>; } catch { return null; } };

async function readById(cfg: GoogleConfig, token: string, id: string): Promise<CalendarResult<{ raw: Record<string, unknown>; event: CalendarEvent }>> {
  const r = await call(cfg, token, 'GET', `events/${id}`);
  if (r.status !== 200) return { ok: false, reason: classify(r.status, r.body) };
  const raw = parse(r.body);
  const event = raw ? normalizeEvent(raw as never, id) : null;
  return raw && event ? { ok: true, value: { raw, event } } : { ok: false, reason: 'unavailable' };
}

export async function createMeetingEvent(cfg: GoogleConfig, token: string, input: NewEventInput): Promise<CalendarResult<CreatedEvent>> {
  const id = eventIdForMeeting(input.meetingId);
  const qs = new URLSearchParams({ conferenceDataVersion: input.withMeet ? '1' : '0', sendUpdates: input.sendInvites ? 'all' : 'none' });
  const body = {
    id,
    summary: input.title,
    ...(input.description ? { description: input.description } : {}),
    start: { dateTime: input.start, timeZone: input.timeZone },
    end: { dateTime: input.end, timeZone: input.timeZone },
    attendees: input.attendees.map((email) => ({ email })),
    guestsCanInviteOthers: false,
    reminders: { useDefault: true },
    ...(input.withMeet ? { conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
  };
  const r = await call(cfg, token, 'POST', `events?${qs.toString()}`, body);
  let duplicate = false;
  let raw: Record<string, unknown> | null = null;
  if (r.status === 200) raw = parse(r.body);
  else if (r.status === 409 || r.status === 599) {
    // already created by an earlier attempt (or unknown outcome): read it back by the fixed id -- never a second insert
    const again = await readById(cfg, token, id);
    if (!again.ok) return r.status === 599 ? { ok: false, reason: 'unavailable' } : again;
    raw = again.value.raw;
    duplicate = true;
  } else return { ok: false, reason: classify(r.status, r.body) };
  if (!raw) return { ok: false, reason: 'unavailable' };
  let meet = meetFrom(raw);
  if (input.withMeet && meet.status === 'pending') {
    await new Promise((res) => setTimeout(res, 1500));
    const again = await readById(cfg, token, id);
    if (again.ok) { raw = again.value.raw; meet = meetFrom(raw); }
  }
  const event = normalizeEvent(raw as never, id);
  if (!event) return { ok: false, reason: 'unavailable' };
  return { ok: true, value: { event, meetUrl: meet.url, meetStatus: meet.status, duplicate } };
}

export async function updateMeetingEvent(cfg: GoogleConfig, token: string, eventId: string, p: { title?: string; start?: string; end?: string; timeZone: string; attendees?: string[]; sendInvites: boolean }): Promise<CalendarResult<CalendarEvent>> {
  const body: Record<string, unknown> = {};
  if (p.title) body.summary = p.title;
  if (p.start) body.start = { dateTime: p.start, timeZone: p.timeZone };
  if (p.end) body.end = { dateTime: p.end, timeZone: p.timeZone };
  if (p.attendees) body.attendees = p.attendees.map((email) => ({ email }));
  const r = await call(cfg, token, 'PATCH', `events/${eventId}?sendUpdates=${p.sendInvites ? 'all' : 'none'}`, body);
  if (r.status !== 200) return { ok: false, reason: classify(r.status, r.body) };
  const raw = parse(r.body);
  const ev = raw ? normalizeEvent(raw as never, eventId) : null;
  return ev ? { ok: true, value: ev } : { ok: false, reason: 'unavailable' };
}

/** Zrušení: 404/410 = už zrušeno = úspěch. */
export async function cancelMeetingEvent(cfg: GoogleConfig, token: string, eventId: string, sendInvites: boolean): Promise<CalendarResult<true>> {
  const r = await call(cfg, token, 'DELETE', `events/${eventId}?sendUpdates=${sendInvites ? 'all' : 'none'}`);
  if (r.status === 204 || r.status === 200 || r.status === 404 || r.status === 410) return { ok: true, value: true };
  return { ok: false, reason: classify(r.status, r.body) };
}
