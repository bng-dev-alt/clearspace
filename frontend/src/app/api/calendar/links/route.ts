import { NextRequest, NextResponse } from 'next/server';
import { CALENDAR_TEXT, getEvent, isEventId, linkRef, sharedFields } from '../../../../lib/google/calendar';
import { ENTITY_ID_RE } from '../../../../lib/google/drive';
import { caller, dbError, errorResponse, HttpError, MSG, NO_STORE, readJson, requireCalendar, withServiceToken } from '../../../../lib/google/server';

/**
 * POST /api/calendar/links { projectId, cardId?, eventIds: string[] (1..10) } -- attach events the caller explicitly selected in
 * their own primary calendar. The server re-reads each event from Google with the caller's OWN token (a forged id or one of
 * another calendar is simply not found), refuses private / confidential and cancelled events, stores ONLY the shared metadata
 * (title, times, flags, attendee count, organizer name or domain) and keeps the event id private (calendar_link_sources).
 * Nothing is created, changed or sent in Google Calendar.
 */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireCalendar();
    const { db } = await caller(req);
    const body = await readJson<{ projectId?: unknown; cardId?: unknown; eventIds?: unknown }>(req);
    const projectId = typeof body.projectId === 'string' && ENTITY_ID_RE.test(body.projectId) ? body.projectId : null;
    const cardId = body.cardId == null ? null : typeof body.cardId === 'string' && ENTITY_ID_RE.test(body.cardId) ? body.cardId : undefined;
    const ids = Array.isArray(body.eventIds) ? [...new Set(body.eventIds as unknown[])] : [];
    if (!projectId || cardId === undefined || ids.length < 1 || ids.length > 10 || !ids.every(isEventId)) {
      throw new HttpError(400, MSG.invalid, 'invalid');
    }
    const { data: canEdit, error: roleErr } = await db.rpc('can_edit_project', { p_project_id: projectId });
    if (roleErr) throw dbError(roleErr);
    if (!canEdit) throw new HttpError(403, 'K tomuto projektu nemáte oprávnění připojovat události.', 'forbidden');
    const { data: subData, error: subErr } = await db.rpc('google_connection_sub', { p_server_secret: cfg.serverSecret, p_candidate_sub: '-' });
    if (subErr) throw dbError(subErr);
    const sub = ((Array.isArray(subData) ? subData[0] : subData) as { own_sub: string | null } | undefined)?.own_sub;
    if (!sub) throw new HttpError(409, MSG.not_connected, 'not_connected');

    const links: { id: string; eventId: string; duplicate: boolean }[] = [];
    const failed: { eventId: string; reason: string; message: string }[] = [];
    for (const eventId of ids as string[]) {
      const r = await withServiceToken('calendar', db, cfg, 1, (token) => getEvent(cfg, token, eventId));
      if (!r.ok) { failed.push({ eventId, reason: r.reason, message: CALENDAR_TEXT[r.reason] }); continue; }
      const ev = r.value;
      if (!('title' in ev) || ev.state === 'deleted') { failed.push({ eventId, reason: 'not_found', message: CALENDAR_TEXT.not_found }); continue; }
      if (ev.private) { failed.push({ eventId, reason: 'private', message: CALENDAR_TEXT.private }); continue; }
      const { data, error } = await db.rpc('calendar_link_add', {
        p_server_secret: cfg.serverSecret, p_project_id: projectId, p_card_id: cardId, p_ref: linkRef(cfg, sub, ev.id), p_google_sub: sub,
        p_event_id: ev.id, p_recurring_event_id: ev.recurringEventId, ...sharedFields(ev),
      });
      if (error) throw dbError(error, 'Událost se nepodařilo připojit.');
      const row = (Array.isArray(data) ? data[0] : data) as { id: string; duplicate: boolean };
      links.push({ id: row.id, eventId, duplicate: row.duplicate });
    }
    return NextResponse.json({ links, failed }, { status: links.some((l) => !l.duplicate) ? 201 : 200, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'calendar-links');
  }
}
