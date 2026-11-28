import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CALENDAR_TEXT, linkRef, sharedFields } from '../../../../lib/google/calendar';
import { cancelMeetingEvent, createMeetingEvent, updateMeetingEvent } from '../../../../lib/google/calendarWrite';
import { serviceAllowedFor } from '../../../../lib/google/config';
import { ENTITY_ID_RE } from '../../../../lib/google/drive';
import { dbError, DISABLED, errorResponse, HttpError, NO_STORE, readJson, requireCalendar, serviceCaller, withServiceToken } from '../../../../lib/google/server';

/**
 * RUN 10 – porada ↔ událost v Google Kalendáři organizátora.
 *  POST   { projectId, meetingId, withMeet, sendInvites, timeZone }  vytvoří událost (+ Google Meet z odpovědi Googlu), připojí ji
 *         k projektu stejnou cestou jako RUN 04 (sdílená metadata, soukromé event id) a naváže ji na poradu (meeting_resource_links).
 *  PATCH  { projectId, meetingId, sendInvites, timeZone }            promítne změněný čas / název / hosty porady do události.
 *  DELETE { projectId, meetingId, sendInvites }                      zruší událost (Google pošle zrušení jen při sendInvites).
 * Jen organizátor porady (autor nebo vlastník projektu), jen s vlastním účtem Google, kde je zapnutý Kalendář I plánování porad.
 * Pozvánky odesílá Google, ne ClearSpace – a jen když to organizátor výslovně zvolí.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TZ = /^[A-Za-z_]{1,30}(\/[A-Za-z0-9_+-]{1,30}){0,2}$/;

interface Body { projectId?: unknown; meetingId?: unknown; withMeet?: unknown; sendInvites?: unknown; timeZone?: unknown }

async function context(req: NextRequest) {
  const cfg = requireCalendar();
  const c = await serviceCaller(req, 'calendar');
  if (!serviceAllowedFor('meetings', c.userId)) throw new HttpError(503, DISABLED.meetings, 'meetings_disabled');
  const body = await readJson<Body>(req);
  const projectId = typeof body.projectId === 'string' && ENTITY_ID_RE.test(body.projectId) ? body.projectId : null;
  const meetingId = typeof body.meetingId === 'string' && UUID.test(body.meetingId) ? body.meetingId.toLowerCase() : null;
  if (!projectId || !meetingId) throw new HttpError(400, 'Neplatný požadavek.', 'invalid');
  const timeZone = typeof body.timeZone === 'string' && TZ.test(body.timeZone) ? body.timeZone : 'Europe/Prague';
  const { data: m, error } = await c.db.from('meetings').select('id, project_id, title, occurred_at, ends_at, created_by, conference_url')
    .eq('id', meetingId).eq('project_id', projectId).maybeSingle();
  if (error) throw dbError(error);
  if (!m) throw new HttpError(404, 'Porada nebyla nalezena.', 'not_found');
  const { data: owner } = await c.db.rpc('is_project_owner', { p_project_id: projectId });
  if (m.created_by !== c.userId && owner !== true) throw new HttpError(403, 'Událost porady spravuje jen její organizátor.', 'forbidden');
  return { cfg, db: c.db, userId: c.userId, projectId, meeting: m as { id: string; title: string; occurred_at: string; ends_at: string | null; conference_url: string | null }, body, timeZone };
}

async function linkedEvent(db: SupabaseClient, meetingId: string): Promise<string | null> {
  const { data } = await db.from('meeting_resource_links').select('link_id, external_resource_links!inner(provider)')
    .eq('meeting_id', meetingId).eq('external_resource_links.provider', 'google_calendar_event').limit(1);
  return (data?.[0] as { link_id?: string } | undefined)?.link_id ?? null;
}

async function attendees(db: SupabaseClient, meetingId: string): Promise<string[]> {
  const { data } = await db.from('meeting_attendees').select('email').eq('meeting_id', meetingId).limit(50);
  return (data ?? []).map((r) => (r as { email: string }).email);
}

const endOf = (m: { occurred_at: string; ends_at: string | null }) => m.ends_at ?? new Date(Date.parse(m.occurred_at) + 3_600_000).toISOString();

export async function POST(req: NextRequest) {
  try {
    const x = await context(req);
    const existing = await linkedEvent(x.db, x.meeting.id);
    if (existing) return NextResponse.json({ linkId: existing, meetUrl: x.meeting.conference_url, duplicate: true }, { headers: NO_STORE });
    const { data: subData, error: subErr } = await x.db.rpc('google_connection_sub', { p_server_secret: x.cfg.serverSecret, p_candidate_sub: '-' });
    if (subErr) throw dbError(subErr);
    const sub = ((Array.isArray(subData) ? subData[0] : subData) as { own_sub: string | null } | undefined)?.own_sub;
    if (!sub) throw new HttpError(409, 'Nejprve připojte svůj účet Google.', 'not_connected');
    const withMeet = x.body.withMeet !== false;
    const guests = await attendees(x.db, x.meeting.id);
    const r = await withServiceToken('meetings', x.db, x.cfg, 2, (token) => createMeetingEvent(x.cfg, token, {
      meetingId: x.meeting.id, title: x.meeting.title, description: 'Porada naplánovaná v ClearSpace.', start: new Date(x.meeting.occurred_at).toISOString(),
      end: new Date(endOf(x.meeting)).toISOString(), timeZone: x.timeZone, attendees: guests, withMeet,
      sendInvites: x.body.sendInvites === true,
    }));
    if (!r.ok) throw new HttpError(r.reason === 'auth' ? 409 : r.reason === 'rate_limited' ? 429 : r.reason === 'forbidden' ? 403 : 503, CALENDAR_TEXT[r.reason], r.reason);
    const ev = r.value.event;
    const { data: link, error: linkErr } = await x.db.rpc('calendar_link_add', {
      p_server_secret: x.cfg.serverSecret, p_project_id: x.projectId, p_card_id: null, p_ref: linkRef(x.cfg, sub, ev.id), p_google_sub: sub,
      p_event_id: ev.id, p_recurring_event_id: null, ...sharedFields(ev),
    });
    if (linkErr) throw dbError(linkErr, 'Událost vznikla, ale nepodařilo se ji připojit k projektu. Zkuste to prosím znovu.');
    const linkId = ((Array.isArray(link) ? link[0] : link) as { id: string }).id;
    const { error: mlErr } = await x.db.from('meeting_resource_links').insert({ meeting_id: x.meeting.id, link_id: linkId, project_id: x.projectId });
    if (mlErr && mlErr.code !== '23505') throw dbError(mlErr);
    if (r.value.meetUrl) {
      const { error: uErr } = await x.db.from('meetings').update({ conference_url: r.value.meetUrl }).eq('id', x.meeting.id);
      if (uErr) throw dbError(uErr);
    }
    return NextResponse.json({ linkId, meetUrl: r.value.meetUrl, meetStatus: r.value.meetStatus, invitesSent: x.body.sendInvites === true && !r.value.duplicate, duplicate: r.value.duplicate },
      { status: 201, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'meeting-calendar-create');
  }
}

async function sourceOf(x: Awaited<ReturnType<typeof context>>) {
  const linkId = await linkedEvent(x.db, x.meeting.id);
  if (!linkId) throw new HttpError(404, 'Porada nemá událost v Google Kalendáři.', 'not_found');
  const { data, error } = await x.db.rpc('calendar_link_source', { p_server_secret: x.cfg.serverSecret, p_link_id: linkId });
  if (error) throw dbError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { event_id: string; same_account: boolean } | undefined;
  if (!row?.same_account) throw new HttpError(409, CALENDAR_TEXT.other_account, 'other_account');
  return { linkId, eventId: row.event_id };
}

export async function PATCH(req: NextRequest) {
  try {
    const x = await context(req);
    const s = await sourceOf(x);
    const r = await withServiceToken('meetings', x.db, x.cfg, 1, async (token) => updateMeetingEvent(x.cfg, token, s.eventId, {
      title: x.meeting.title, start: new Date(x.meeting.occurred_at).toISOString(), end: new Date(endOf(x.meeting)).toISOString(), timeZone: x.timeZone,
      attendees: await attendees(x.db, x.meeting.id), sendInvites: x.body.sendInvites === true,
    }));
    if (!r.ok) throw new HttpError(r.reason === 'not_found' ? 404 : 503, CALENDAR_TEXT[r.reason], r.reason);
    await x.db.rpc('calendar_link_refresh', { p_server_secret: x.cfg.serverSecret, p_link_id: s.linkId, ...sharedFields(r.value) });
    return NextResponse.json({ updated: true }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'meeting-calendar-update');
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const x = await context(req);
    const s = await sourceOf(x);
    const r = await withServiceToken('meetings', x.db, x.cfg, 1, (token) => cancelMeetingEvent(x.cfg, token, s.eventId, x.body.sendInvites === true));
    if (!r.ok) throw new HttpError(503, CALENDAR_TEXT[r.reason], r.reason);
    // RUN 04 rule: the link row stays with provider_state 'deleted' (never silently vanishes); the meeting keeps its history
    await x.db.rpc('calendar_link_refresh', { p_server_secret: x.cfg.serverSecret, p_link_id: s.linkId, p_title: null, p_start: null, p_end: null, p_all_day: null,
      p_time_zone: null, p_recurring: null, p_attendees: null, p_organizer: null, p_updated: null, p_state: 'deleted' });
    if (x.meeting.conference_url?.startsWith('https://meet.google.com/')) await x.db.from('meetings').update({ conference_url: null }).eq('id', x.meeting.id);
    return NextResponse.json({ cancelled: true }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'meeting-calendar-cancel');
  }
}
