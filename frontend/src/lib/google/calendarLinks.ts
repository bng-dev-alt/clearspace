import type { SupabaseClient } from '@supabase/supabase-js';
import { CALENDAR_READONLY_SCOPE, type GoogleConfig } from './config';
import { CALENDAR_TEXT, sharedFields, type CalendarEvent } from './calendar';
import { LINK_ID_RE } from './gmailLinks';
import { dbError, HttpError, MSG } from './server';

/** RUN 04: shared route plumbing for one Calendar link (server only). */

/**
 * The private source of a link -- only for the person who linked it, only while they are a project member, only while the
 * SAME Google account (with Calendar) is connected. Everyone else gets a refusal without any event identifier.
 */
export async function ownCalendarSource(db: SupabaseClient, cfg: GoogleConfig, linkId: string): Promise<{ eventId: string }> {
  if (!LINK_ID_RE.test(linkId)) throw new HttpError(404, 'Událost nebyla nalezena.', 'not_found');
  const { data, error } = await db.rpc('calendar_link_source', { p_server_secret: cfg.serverSecret, p_link_id: linkId });
  if (error) {
    if (error.code === '42501') throw new HttpError(403, CALENDAR_TEXT.not_owner, 'not_owner');
    throw dbError(error);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { event_id: string; same_account: boolean } | undefined;
  if (!row) throw new HttpError(403, CALENDAR_TEXT.not_owner, 'not_owner');
  if (!row.same_account) {
    const { data: st } = await db.rpc('google_connection_status');
    const c = (Array.isArray(st) ? st[0] : st) as { scopes?: string[]; status?: string } | undefined;
    if (!c) throw new HttpError(409, MSG.not_connected, 'not_connected');
    if (c.status !== 'active') throw new HttpError(409, MSG.revoked, 'revoked');
    if (!c.scopes?.includes(CALENDAR_READONLY_SCOPE)) throw new HttpError(409, MSG.calendar_not_granted, 'calendar_not_granted');
    throw new HttpError(409, CALENDAR_TEXT.other_account, 'other_account');
  }
  return { eventId: row.event_id };
}

/** Store refreshed SHARED metadata (owner only; a refusal, e.g. the owner is now a read-only Čtenář, is not an error). */
export async function storeCalendarShared(db: SupabaseClient, cfg: GoogleConfig, linkId: string, ev: CalendarEvent | { state: 'ok' | 'deleted' }): Promise<boolean> {
  const fields = 'title' in ev ? sharedFields(ev) : {
    p_title: null, p_start: null, p_end: null, p_all_day: null, p_time_zone: null, p_recurring: null, p_attendees: null, p_organizer: null, p_updated: null, p_state: ev.state,
  };
  const { data, error } = await db.rpc('calendar_link_refresh', { p_server_secret: cfg.serverSecret, p_link_id: linkId, ...fields });
  return !error && Boolean(data);
}
