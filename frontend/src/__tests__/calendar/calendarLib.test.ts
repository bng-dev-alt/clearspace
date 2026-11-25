import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { CALENDAR_READONLY_SCOPE, CALENDAR_SCOPES, SERVICE_SCOPE, SERVICE_SCOPES, calendarFeatureEnabled, googleConfig } from '../../lib/google/config';
import { getEvent, linkRef, listEvents, normalizeEvent, parseRange, safeHtmlLink, sharedFields, sharedOrganizer } from '../../lib/google/calendar';
import { eventDayKeys, eventWhen } from '../../services/calendarService';
import { fromCalendarEvent, assertAiUseAllowed } from '../../lib/resources/contract';
import { describeActivity } from '../../lib/collab/activityText';
import type { GoogleConfig } from '../../lib/google/config';

const cfg = { serverSecret: 's'.repeat(40), endpoints: { calendar: 'http://127.0.0.1:1/calendar/v3' } } as unknown as GoogleConfig;
const base = {
  id: 'kickoffcorvane0001', status: 'confirmed', summary: 'Kickoff', start: { dateTime: '2026-12-01T09:00:00+01:00', timeZone: 'Europe/Prague' },
  end: { dateTime: '2026-12-01T10:30:00+01:00', timeZone: 'Europe/Prague' }, organizer: { displayName: 'Jana', email: 'jana@corvane.example' },
  attendees: [{ responseStatus: 'accepted' }, { responseStatus: 'needsAction' }], htmlLink: 'https://www.google.com/calendar/event?eid=abc', updated: '2026-11-20T08:00:00Z',
  description: 'SOUKROMÉ', location: 'Adresa', hangoutLink: 'https://meet.google.com/x',
};

describe('Calendar config (least privilege, switch)', () => {
  it('one read-only scope, owned calendars only; switch default OFF', () => {
    expect(CALENDAR_READONLY_SCOPE).toBe('https://www.googleapis.com/auth/calendar.events.owned.readonly');
    expect(CALENDAR_SCOPES).toEqual(['openid', 'email', CALENDAR_READONLY_SCOPE]);
    expect(SERVICE_SCOPE.calendar).toBe(CALENDAR_READONLY_SCOPE);
    expect(SERVICE_SCOPES.drive.some((s) => s.includes('calendar')) || SERVICE_SCOPES.gmail.some((s) => s.includes('calendar'))).toBe(false);
    expect(calendarFeatureEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(calendarFeatureEnabled({ CALENDAR_INTEGRATION_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(calendarFeatureEnabled({ CALENDAR_INTEGRATION_ENABLED: ' 1 ' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
  it('real endpoint is Google\'s Calendar v3; the mock seam only on loopback outside production', () => {
    const env = { GOOGLE_OAUTH_CLIENT_ID: 'id-1234567890.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx', GOOGLE_SERVER_SECRET: 'x'.repeat(40),
      GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), GOOGLE_PICKER_API_KEY: 'AIzaxxxxxxxxxxxx', GOOGLE_CLOUD_PROJECT_NUMBER: '123456', APP_BASE_URL: 'http://127.0.0.1:3461' } as unknown as NodeJS.ProcessEnv;
    const real = googleConfig(env);
    expect(real.enabled && real.endpoints.calendar).toBe('https://www.googleapis.com/calendar/v3');
    const mock = googleConfig({ ...env, GOOGLE_API_MOCK_BASE: 'http://127.0.0.1:55592', GOOGLE_OAUTH_CLIENT_SECRET: 'mock-x' } as NodeJS.ProcessEnv);
    expect(mock.enabled && mock.endpoints.calendar).toBe('http://127.0.0.1:55592/calendar/v3');
  });
  it('no write call exists in the Calendar code (read-only by construction)', () => {
    for (const f of ['src/lib/google/calendar.ts', 'src/lib/google/calendarLinks.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
      expect(src).not.toMatch(/\/(insert|import|quickAdd|watch|move)\b/);
    }
  });
});

describe('E8 range', () => {
  it('[from, to) instants, at most 42 days', () => {
    expect(parseRange('2026-12-01T00:00:00Z', '2027-01-12T00:00:00Z')).toEqual({ from: '2026-12-01T00:00:00.000Z', to: '2027-01-12T00:00:00.000Z' });
    expect(parseRange('2026-12-01T00:00:00+01:00', '2026-12-02T00:00:00+01:00')).toEqual({ from: '2026-11-30T23:00:00.000Z', to: '2026-12-01T23:00:00.000Z' });
    expect(parseRange('2026-12-01T00:00:00Z', '2027-01-12T00:00:01Z')).toBeNull();
    expect(parseRange('2026-12-02T00:00:00Z', '2026-12-01T00:00:00Z')).toBeNull();
    expect(parseRange('2026-12-01T00:00:00Z', '2026-12-01T00:00:00Z')).toBeNull();
    expect(parseRange('2026-12-01', '2026-12-02')).toBeNull();
    expect(parseRange('2026-12-01T00:00:00Z', undefined)).toBeNull();
  });
});

describe('normalization (privacy, E1-E6)', () => {
  it('timed event: shared fields only; no description / location / Meet / addresses in the output', () => {
    const e = normalizeEvent(base as never)!;
    expect(e).toMatchObject({ id: 'kickoffcorvane0001', title: 'Kickoff', start: '2026-12-01T08:00:00.000Z', end: '2026-12-01T09:30:00.000Z', allDay: false,
      timeZone: 'Europe/Prague', recurring: false, modified: false, attendees: 2, organizer: 'Jana', private: false, state: 'ok' });
    const text = JSON.stringify(e);
    for (const leak of ['SOUKROMÉ', 'Adresa', 'meet.google', 'corvane.example', 'description', 'location']) expect(text).not.toContain(leak);
    expect(Object.keys(sharedFields(e)).sort()).toEqual(['p_all_day', 'p_attendees', 'p_end', 'p_organizer', 'p_recurring', 'p_start', 'p_state', 'p_time_zone', 'p_title', 'p_updated']);
    expect(JSON.stringify(sharedFields(e))).not.toContain('google.com');
  });
  it('E3 all-day (end exclusive, no zone shift) and multi-day', () => {
    const e = normalizeEvent({ ...base, start: { date: '2026-11-30' }, end: { date: '2026-12-03' } } as never)!;
    expect([e.allDay, e.start, e.end]).toEqual([true, '2026-11-30T00:00:00.000Z', '2026-12-03T00:00:00.000Z']);
    expect(eventDayKeys(e)).toEqual(['2026-11-30', '2026-12-01', '2026-12-02']);
    expect(eventWhen(e)).toBe('30. 11. 2026 – 2. 12. 2026 (celý den)');
    const one = normalizeEvent({ ...base, start: { date: '2026-12-24' }, end: { date: '2026-12-25' } } as never)!;
    expect(eventDayKeys(one)).toEqual(['2026-12-24']); expect(eventWhen(one)).toBe('24. 12. 2026 (celý den)');
    expect(normalizeEvent({ ...base, start: { date: '2026-12-24' }, end: { dateTime: '2026-12-25T00:00:00Z' } } as never)).toBeNull();
  });
  it('E1/E2 occurrences: recurring flag + series id; a moved occurrence is "modified"', () => {
    const occ = normalizeEvent({ ...base, id: 'standup01_20261216T080000Z', recurringEventId: 'standup01', originalStartTime: { dateTime: '2026-12-16T09:00:00+01:00' }, start: { dateTime: '2026-12-16T09:00:00+01:00' }, end: { dateTime: '2026-12-16T09:30:00+01:00' } } as never)!;
    expect([occ.recurring, occ.recurringEventId, occ.modified]).toEqual([true, 'standup01', false]);
    const moved = normalizeEvent({ ...base, id: 'standup01_20261202T080000Z', recurringEventId: 'standup01', originalStartTime: { dateTime: '2026-12-02T09:00:00+01:00' }, start: { dateTime: '2026-12-02T10:30:00+01:00' }, end: { dateTime: '2026-12-02T11:00:00+01:00' } } as never)!;
    expect(moved.modified).toBe(true);
  });
  it('E5 cancelled = deleted; E6 private / confidential flagged', () => {
    expect(normalizeEvent({ id: 'cancelled0001', status: 'cancelled' } as never)!.state).toBe('deleted');
    expect(normalizeEvent({ ...base, visibility: 'private' } as never)!.private).toBe(true);
    expect(normalizeEvent({ ...base, visibility: 'confidential' } as never)!.private).toBe(true);
    expect(normalizeEvent({ ...base, visibility: 'public' } as never)!.private).toBe(false);
  });
  it('untrusted input: ids, ids of other requests, times, zone, title, organizer, links', () => {
    expect(normalizeEvent({ ...base, id: '../x' } as never)).toBeNull();
    expect(normalizeEvent(base as never, 'otherid00001')).toBeNull();
    expect(normalizeEvent({ ...base, end: { dateTime: '2026-12-01T07:00:00Z' } } as never)).toBeNull();
    expect(normalizeEvent({ ...base, start: { dateTime: 'nope' } } as never)).toBeNull();
    expect(normalizeEvent({ ...base, start: { ...base.start, timeZone: 'Europe/Prague; drop' } } as never)!.timeZone).toBeNull();
    const t = normalizeEvent({ ...base, summary: '<b>x</b>‮\u0007' + 'a'.repeat(400) } as never)!.title;
    expect(t.length).toBe(300); expect(t).not.toMatch(/[‮\u0007]/);
    expect(normalizeEvent({ ...base, summary: '' } as never)!.title).toBe('(bez názvu)');
    expect(sharedOrganizer({ email: 'Petr@Firma.CZ' })).toBe('@firma.cz');
    expect(sharedOrganizer({})).toBe('Neznámý organizátor');
    expect(safeHtmlLink('javascript:alert(1)')).toBeNull();
    expect(safeHtmlLink('https://evil.example/calendar/event?eid=x')).toBeNull();
    expect(safeHtmlLink('http://www.google.com/calendar/event?eid=x')).toBeNull();
    expect(safeHtmlLink('https://calendar.google.com/calendar/event?eid=x')).toBe('https://calendar.google.com/calendar/event?eid=x');
  });
  it('opaque link ref: deterministic, per account, reveals no id', () => {
    const r = linkRef(cfg, '111', 'kickoffcorvane0001');
    expect(r).toBe(linkRef(cfg, '111', 'kickoffcorvane0001'));
    expect(r).not.toBe(linkRef(cfg, '222', 'kickoffcorvane0001'));
    expect(r).not.toContain('kickoff'); expect(r).toMatch(/^[A-Za-z0-9_-]{40}$/);
  });
  it('E4 local display: zone label when the event zone differs from the viewer\'s; local day keys of a timed event', () => {
    const ny = { start: '2026-12-03T15:00:00.000Z', end: '2026-12-03T16:00:00.000Z', allDay: false, timeZone: 'America/New_York' };
    expect(eventWhen(ny)).toContain('pásmo události America/New_York');
    const local = new Date(2026, 11, 10, 16, 0); const localEnd = new Date(2026, 11, 11, 12, 0);
    expect(eventDayKeys({ start: local.toISOString(), end: localEnd.toISOString(), allDay: false })).toEqual(['2026-12-10', '2026-12-11']);
    const toMidnight = new Date(2026, 11, 12, 0, 0);
    expect(eventDayKeys({ start: new Date(2026, 11, 11, 22, 0).toISOString(), end: toMidnight.toISOString(), allDay: false })).toEqual(['2026-12-11']);
  });
});

describe('API calls (mocked fetch): fields trimming, failures, E5', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  it('list asks for trimmed fields, expanded occurrences, overlap range; skips working-location markers and duplicates', async () => {
    const f = reply(200, { items: [base, base, { ...base, id: 'worklocation01', eventType: 'workingLocation' }], nextPageToken: 'p2' });
    vi.stubGlobal('fetch', f);
    const r = await listEvents(cfg, 't', { from: '2026-12-01T00:00:00.000Z', to: '2026-12-02T00:00:00.000Z', q: 'kick', pageSize: 20 });
    expect(r.ok && r.value.items.map((e) => e.id)).toEqual(['kickoffcorvane0001']);
    expect(r.ok && r.value.nextPageToken).toBe('p2');
    const url = new URL((f.mock.calls[0] as unknown as [string])[0]);
    expect(url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ singleEvents: 'true', orderBy: 'startTime', timeMin: '2026-12-01T00:00:00.000Z', timeMax: '2026-12-02T00:00:00.000Z', q: 'kick', maxResults: '20' });
    expect(url.searchParams.get('fields')).toMatch(/^items\(id,status,summary,start,end,.*attendees\(responseStatus\).*\),nextPageToken$/);
    expect(url.searchParams.get('fields')).not.toMatch(/description|location|conferenceData|hangoutLink|attachments|attendees\(email/);
  });
  it.each([[404, 'deleted'], [410, 'deleted']])('get %s -> state deleted', async (status, state) => {
    vi.stubGlobal('fetch', reply(status, {}));
    const r = await getEvent(cfg, 't', 'kickoffcorvane0001');
    expect(r.ok && r.value.state).toBe(state);
  });
  it.each([[401, '', 'auth'], [403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', 'rate_limited'], [403, '{"error":{"errors":[{"reason":"forbidden"}]}}', 'forbidden'], [500, '', 'unavailable']])('get %s -> %s', async (status, body, reason) => {
    vi.stubGlobal('fetch', reply(status, body));
    const r = await getEvent(cfg, 't', 'kickoffcorvane0001');
    expect(!r.ok && r.reason).toBe(reason);
  });
  it('a forged id never reaches fetch', async () => {
    const f = reply(200, base); vi.stubGlobal('fetch', f);
    const r = await getEvent(cfg, 't', '../../users/me');
    expect(!r.ok && r.reason).toBe('not_found'); expect(f).not.toHaveBeenCalled();
  });
});

describe('activity + Project Intelligence contract', () => {
  it('activity names no event', () => {
    expect(describeActivity({ actionType: 'event_linked', details: {}, actorName: 'Alice' } as never).text).toBe('připojil(a) k projektu událost z Google Kalendáře');
    expect(describeActivity({ actionType: 'event_unlinked', details: { title: 'Kickoff' }, actorName: 'Alice' } as never).text).toMatch(/odebral\(a\) událost z Google Kalendáře od úkolu/);
  });
  it('calendar event document: shared metadata only, provider-neutral link id citation, never consented for AI', () => {
    const L = '11111111-1111-4111-8111-111111111111';
    const d = fromCalendarEvent(L, { title: 'Kickoff', start: '2026-12-01T08:00:00.000Z', end: '2026-12-01T09:30:00.000Z', allDay: false, organizer: 'Jana', attendees: 4, retrievedAt: 'now' });
    expect(d.segments[0].ref).toBe(`google_calendar_event:${L}#1`);
    expect(d).toMatchObject({ trust: 'untrusted', aiUse: 'not_consented', source: { provider: 'google_calendar_event', linkId: L } });
    expect(() => assertAiUseAllowed(d)).toThrow(/not consented/);
  });
});
