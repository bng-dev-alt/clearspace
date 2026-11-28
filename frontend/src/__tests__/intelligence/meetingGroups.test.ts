import { describe, expect, test } from 'vitest';
import { groupMeetings, meetingGroup, startsSoon } from '../../lib/meetings/groups';
import { plural } from '../../lib/plural';
import type { Meeting } from '../../services/meetingService';

// Wednesday 2026-12-02 10:00 local
const NOW = new Date(2026, 11, 2, 10, 0, 0).getTime();
const at = (d: number, h: number, m = 0) => new Date(2026, 11, d, h, m).toISOString();
const mk = (id: string, occurredAt: string, extra: Partial<Meeting> = {}): Meeting => ({
  id, projectId: 'p', title: id, occurredAt, sourceKind: 'audio', status: 'draft', currentRevision: null, speakerNames: {}, languageHint: null,
  createdAt: at(1, 9), audio: {} as Meeting['audio'], endsAt: null, conferenceUrl: null, createdBy: null, live: { state: 'idle', ms: 0, segments: 0 }, ...extra,
});

describe('RUN 11 #15/#22 meeting groups (presentation only)', () => {
  test('today / this week / later / overdue / done / live', () => {
    expect(meetingGroup(mk('a', at(2, 14)), NOW)).toBe('today');
    expect(meetingGroup(mk('b', at(6, 9)), NOW)).toBe('week');          // Sunday of the same week
    expect(meetingGroup(mk('c', at(7, 9)), NOW)).toBe('later');         // next Monday
    expect(meetingGroup(mk('d', at(1, 9), { endsAt: at(1, 10) }), NOW)).toBe('overdue');
    expect(meetingGroup(mk('e', at(1, 9), { currentRevision: 'r1', status: 'transcribed' }), NOW)).toBe('done');
    expect(meetingGroup(mk('f', at(2, 9), { live: { state: 'live', ms: 1, segments: 0 } }), NOW)).toBe('live');
    expect(meetingGroup(mk('g', at(1, 9), { live: { state: 'stopped', ms: 1, segments: 2 } }), NOW)).toBe('live');
    // a meeting that is running right now (started 9:30, ends 11:00) is still "today", not overdue
    expect(meetingGroup(mk('h', at(2, 9, 30), { endsAt: at(2, 11) }), NOW)).toBe('today');
  });

  test('start-transcript hint only for today, within 15 min or running, nothing started', () => {
    expect(startsSoon(mk('a', at(2, 10, 10)), NOW)).toBe(true);
    expect(startsSoon(mk('b', at(2, 9, 30), { endsAt: at(2, 11) }), NOW)).toBe(true);
    expect(startsSoon(mk('c', at(2, 14)), NOW)).toBe(false);
    expect(startsSoon(mk('d', at(6, 9)), NOW)).toBe(false);
  });

  test('group order and sorting: upcoming ascending, past descending', () => {
    const g = groupMeetings([mk('late', at(2, 16)), mk('old', at(1, 9), { endsAt: at(1, 10) }), mk('early', at(2, 11)), mk('older', at(1, 7), { endsAt: at(1, 8) })], NOW);
    expect(g.map((x) => x.group)).toEqual(['today', 'overdue']);
    expect(g[0].items.map((m) => m.id)).toEqual(['early', 'late']);
    expect(g[1].items.map((m) => m.id)).toEqual(['old', 'older']);
  });

  test('Czech plural agreement', () => {
    expect([0, 1, 2, 4, 5, 22].map((n) => `${n} ${plural(n, 'návrh', 'návrhy', 'návrhů')}`))
      .toEqual(['0 návrhů', '1 návrh', '2 návrhy', '4 návrhy', '5 návrhů', '22 návrhů']);
  });
});
