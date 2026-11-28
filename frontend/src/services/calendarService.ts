import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { api, DriveError } from './driveService';

/**
 * Google Calendar, client side (RUN 04). The browser never receives a Google token for Calendar: listing, attaching, refreshing
 * and opening run on the server with the caller's own token. Linked events (shared metadata only) are read under RLS.
 */
export const CALENDAR_PRIVACY_TEXT = 'Členové projektu uvidí jen název události, čas, zda jde o opakovanou událost, počet účastníků, organizátora (jméno, případně jen doménu) a kdo událost připojil. Popis, místo, adresy účastníků a odkazy na schůzky zůstávají jen ve vašem kalendáři. Soukromé a důvěrné události připojit nelze.';
export const MY_LAYER_TEXT = 'Vaše události z Google Kalendáře vidíte jen vy. Nic se neukládá a ostatní členové projektu je nevidí.';

/** A linked event: what every project member may see. */
export interface CalendarLink {
  id: string;
  projectId: string;
  cardId: string | null;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string | null;
  recurring: boolean;
  attendees: number;
  organizer: string | null;
  state: 'ok' | 'deleted';
  linkedBy: string | null;
  linkedByName: string;
  createdAt: string;
  checkedAt: string;
}
/** One of the caller's own events (their personal layer / the picker). Never stored. */
export interface OwnEvent {
  id: string;
  recurringEventId: string | null;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string | null;
  recurring: boolean;
  modified: boolean;
  attendees: number;
  organizer: string;
  private: boolean;
  state: 'ok' | 'deleted';
  htmlLink: string | null;
}
export interface EventPage { items: OwnEvent[]; nextPageToken: string | null }
export interface CalendarAttachResult {
  links: { id: string; eventId: string; duplicate: boolean }[];
  failed: { eventId: string; reason: string; message: string }[];
}

interface Row {
  id: string; project_id: string; card_id: string | null; name: string; event_start: string; event_end: string; event_all_day: boolean;
  event_time_zone: string | null; event_recurring: boolean; event_attendees: number; event_organizer: string | null;
  provider_state: CalendarLink['state']; linked_by: string | null; linked_by_name: string; created_at: string; metadata_checked_at: string;
}
const COLS = 'id, project_id, card_id, name, event_start, event_end, event_all_day, event_time_zone, event_recurring, event_attendees, event_organizer, provider_state, linked_by, linked_by_name, created_at, metadata_checked_at';
export const mapCalendarLink = (r: Row): CalendarLink => ({
  id: r.id, projectId: r.project_id, cardId: r.card_id, title: r.name, start: r.event_start, end: r.event_end, allDay: r.event_all_day,
  timeZone: r.event_time_zone, recurring: r.event_recurring, attendees: r.event_attendees, organizer: r.event_organizer, state: r.provider_state,
  linkedBy: r.linked_by, linkedByName: r.linked_by_name, createdAt: r.created_at, checkedAt: r.metadata_checked_at,
});

export const calendarService = {
  available: hasSupabaseConfig,

  async list(projectId: string, cardId?: string): Promise<CalendarLink[]> {
    if (!hasSupabaseConfig) return [];
    let q = supabase.from('external_resource_links').select(COLS)
      .eq('project_id', projectId).eq('provider', 'google_calendar_event').order('event_start', { ascending: true }).limit(500);
    if (cardId) q = q.eq('card_id', cardId);
    const { data, error } = await q;
    if (error) throw new DriveError('db', 'Události se nepodařilo načíst.');
    return (data as Row[]).map(mapCalendarLink);
  },

  events(p: { from: string; to: string; q?: string; pageToken?: string | null; pageSize?: number }): Promise<EventPage> {
    const q = new URLSearchParams({ from: p.from, to: p.to, pageSize: String(p.pageSize ?? 20) });
    if (p.q) q.set('q', p.q);
    if (p.pageToken) q.set('pageToken', p.pageToken);
    return api<EventPage>(`/api/calendar/events?${q.toString()}`);
  },

  attach(projectId: string, cardId: string | null, eventIds: string[]): Promise<CalendarAttachResult> {
    return api<CalendarAttachResult>('/api/calendar/links', { method: 'POST', body: { projectId, cardId, eventIds } });
  },

  refresh(linkId: string): Promise<{ state: CalendarLink['state']; private: boolean; updated: boolean }> {
    return api(`/api/calendar/links/${encodeURIComponent(linkId)}/refresh`, { method: 'POST', body: {} });
  },

  async openUrl(linkId: string): Promise<string> {
    return (await api<{ url: string }>(`/api/calendar/links/${encodeURIComponent(linkId)}/open`)).url;
  },

  /** Removes the association only; nothing in Google Calendar changes. */
  async remove(linkId: string): Promise<void> {
    const { data, error } = await supabase.from('external_resource_links').delete().eq('id', linkId).select('id');
    if (error) throw new DriveError(error.code ?? 'db', error.code === '42501' ? 'K odebrání události nemáte oprávnění.' : 'Událost se nepodařilo odebrat.');
    if (!data?.length) throw new DriveError('forbidden', 'Událost se nepodařilo odebrat (možná už byla odebrána, nebo k tomu nemáte oprávnění).');
  },

  /** Turn Calendar off in ClearSpace (Drive + Gmail untouched); `purge` also removes every event link this user created. */
  /** RUN 10: stop using the Calendar WRITE permission (meeting scheduling); reading and existing events stay. */
  disableMeetings(): Promise<{ removed: boolean }> {
    return api('/api/meetings/calendar/connection', { method: 'DELETE' });
  },

  disable(purge: boolean): Promise<{ calendarRemoved: boolean; purged: { removed: number; skipped: number } | null }> {
    return api(`/api/calendar/connection${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
  },
};

// ---------------------------------------------------------------- display helpers (E3/E4)
/** Day keys (local YYYY-MM-DD) an event covers. All-day: Google's dates as-is (end exclusive), never shifted by a zone. */
export function eventDayKeys(e: { start: string; end: string; allDay: boolean }): string[] {
  const keys: string[] = [];
  if (e.allDay) {
    const s = Date.parse(e.start); const end = Date.parse(e.end);
    for (let t = s; t < Math.max(end, s + 1); t += 86_400_000) keys.push(new Date(t).toISOString().slice(0, 10));
    return keys.slice(0, 62);
  }
  const s = new Date(e.start); const end = new Date(e.end);
  const day = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  // a timed event ending exactly at local midnight does not cover the next day
  while (day < end || keys.length === 0) {
    keys.push(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`);
    day.setDate(day.getDate() + 1);
    if (keys.length >= 62) break;
  }
  return keys;
}
const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'Europe/Prague'; } };
/** "1. 12. 2026 9:00–10:30" / "24. 12. 2026 (celý den)" / multi-day ranges; zone label when the event's zone differs. */
export function eventWhen(e: { start: string; end: string; allDay: boolean; timeZone?: string | null }): string {
  if (e.allDay) {
    const s = new Date(e.start); const last = new Date(Date.parse(e.end) - 86_400_000);
    const d = (x: Date) => x.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return last.getTime() > s.getTime() ? `${d(s)} – ${d(last)} (celý den)` : `${d(s)} (celý den)`;
  }
  const s = new Date(e.start); const end = new Date(e.end);
  const date = (x: Date) => x.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
  const time = (x: Date) => x.toLocaleTimeString('cs-CZ', { hour: 'numeric', minute: '2-digit' });
  const same = s.toDateString() === end.toDateString();
  const zone = e.timeZone && e.timeZone !== viewerZone() ? ` · pásmo události ${e.timeZone}` : '';
  return (same ? `${date(s)} ${time(s)}–${time(end)}` : `${date(s)} ${time(s)} – ${date(end)} ${time(end)}`) + zone;
}
