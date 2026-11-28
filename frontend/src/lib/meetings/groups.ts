import type { Meeting } from '../../services/meetingService';

/**
 * RUN 11 (#15, #22): presentation-only grouping of the meetings a project already has. No new data, no server call.
 *  live      live transcription running, paused, or stopped with stored parts (unfinished)
 *  today     planned for today (local day), not transcribed yet
 *  week      planned for the rest of this week (Mon–Sun, local)
 *  later     planned after this week
 *  overdue   the planned time is over but there is no transcript ("Uplynulý termín")
 *  done      has a transcript (pasted, uploaded or live) – "Proběhlé"
 * `startSoon` = planned today, starts within 15 min or already running, nobody started a transcript: the list shows the hint.
 */
export type MeetingGroup = 'live' | 'today' | 'week' | 'later' | 'overdue' | 'done';
export const GROUP_ORDER: MeetingGroup[] = ['live', 'today', 'week', 'later', 'overdue', 'done'];
export const GROUP_LABEL: Record<MeetingGroup, string> = {
  live: 'Probíhající a nedokončené přepisy', today: 'Dnes', week: 'Tento týden', later: 'Později', overdue: 'Uplynulý termín bez přepisu', done: 'Proběhlé',
};

const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const weekEnd = (t: number) => { const d = new Date(dayStart(t)); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() + (7 - dow)); return d.getTime(); };

export function hasTranscript(m: Pick<Meeting, 'currentRevision' | 'status' | 'live'>): boolean {
  return !!m.currentRevision || m.status !== 'draft' || m.live.state === 'finalized';
}

export function meetingGroup(m: Meeting, now: number): MeetingGroup {
  if (m.live.state === 'live' || m.live.state === 'paused' || (m.live.state === 'stopped' && m.live.segments > 0)) return 'live';
  if (hasTranscript(m)) return 'done';
  const start = Date.parse(m.occurredAt);
  const end = Date.parse(m.endsAt ?? m.occurredAt);
  if (end <= now) return 'overdue';
  if (start < dayStart(now) + 86_400_000) return 'today';
  if (start < weekEnd(now)) return 'week';
  return 'later';
}

export function startsSoon(m: Meeting, now: number): boolean {
  if (meetingGroup(m, now) !== 'today' || m.live.state !== 'idle') return false;
  return Date.parse(m.occurredAt) - now <= 15 * 60_000;
}

export function groupMeetings(list: Meeting[], now: number): Array<{ group: MeetingGroup; items: Meeting[] }> {
  const by = new Map<MeetingGroup, Meeting[]>();
  for (const m of list) { const g = meetingGroup(m, now); by.set(g, [...(by.get(g) ?? []), m]); }
  return GROUP_ORDER.filter((g) => by.has(g)).map((g) => {
    const items = by.get(g)!;
    const asc = g === 'today' || g === 'week' || g === 'later' || g === 'live';
    items.sort((a, b) => (asc ? 1 : -1) * (Date.parse(a.occurredAt) - Date.parse(b.occurredAt)));
    return { group: g, items };
  });
}
