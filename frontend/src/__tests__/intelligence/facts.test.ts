import { describe, test, expect } from 'vitest';
import { computeProjectFacts, todayInTz } from '../../lib/intelligence/facts';
import { computeProjectIntelligence, dueDateKey } from '../../lib/projectIntelligence';
import { computeCompletionStats } from '../../lib/dashboardStats';
import { act, card, col, member, NOW } from './fixtures';

const board = () => [
  col('c-backlog', 'Nápady / Backlog', [card('b1', { dueDate: '2026-12-31' })]),
  col('c-todo', 'K řešení', [
    card('t1', { dueDate: '2026-11-10', tag: 'Blokováno' }), // po termínu + blokováno
    card('t2', { dueDate: '2026-11-20', priority: 'High' }), // tento týden
    card('t3', { assignees: [] }), // nepřiřazená, bez termínu
    card('t4', { dueDate: 'zítra', assignees: [member('m2', 'Jana')] }), // neplatný termín
    card('t5', { archived: true, dueDate: '2020-01-01' }), // archivovaná se nepočítá
  ]),
  col('c-rev', 'Revize', [card('r1', { dueDate: '2026-11-18' })]),
  col('c-done', 'Hotovo', [card('d1', { dueDate: '2020-01-01' })]), // hotová po termínu se nepočítá
];

describe('computeProjectFacts', () => {
  const facts = computeProjectFacts(board(), [], NOW);

  test('counts follow the same rules as the existing deterministic layer', () => {
    expect(facts.counts.total).toBe(7); // bez archivované
    expect(facts.counts.archived).toBe(1);
    expect(facts.counts.done).toBe(1);
    expect(facts.counts.active).toBe(6);
    expect(facts.counts.blocked).toBe(1);
    expect(facts.counts.overdue).toBe(1); // jen t1
    expect(facts.counts.unassigned).toBe(1);
    expect(facts.counts.highPriority).toBe(1);
    expect(facts.counts.inReview).toBe(1);
  });
  test('id lists let the UI and the model point at concrete cards', () => {
    expect(facts.lists.overdueCardIds).toEqual(['t1']);
    expect(facts.lists.blockedCardIds).toEqual(['t1']);
    expect(facts.lists.unassignedCardIds).toEqual(['t3']);
    expect(facts.lists.dueSoonCardIds).toEqual(['t2', 'r1']);
  });
  test('health is exactly the existing computeProjectIntelligence result (single formula)', () => {
    const today = todayInTz(NOW);
    expect(facts.health).toEqual(computeProjectIntelligence(board(), NOW, today).health);
  });
  test('score consistency: facts overdue equals the overdue penalty basis', () => {
    expect(facts.health.breakdown.find((b) => b.label === 'Po termínu')?.delta).toBe(-6 * facts.counts.overdue);
  });
  test('invalid due dates are reported, never compared as strings', () => {
    expect(facts.dataQuality.invalidDueDateCardIds).toEqual(['t4']);
    expect(facts.lists.overdueCardIds).not.toContain('t4');
  });
  test('archived and done cards never appear in overdue/due-soon lists', () => {
    expect([...facts.lists.overdueCardIds, ...facts.lists.dueSoonCardIds]).not.toContain('t5');
    expect(facts.lists.overdueCardIds).not.toContain('d1');
  });
  test('noDueDate counts only active cards without a date', () => expect(facts.counts.noDueDate).toBe(1));
  test('workload per assignee with this-week counts', () => {
    const petr = facts.workload.find((w) => w.memberId === 'm1')!;
    expect(petr.open).toBe(4); // b1,t1,t2,r1
    expect(petr.dueThisWeek).toBe(2); // t2, r1
  });
  test('lists are capped at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => card(`o${i}`, { dueDate: '2020-01-01' }));
    expect(computeProjectFacts([col('c', 'Todo', many)], [], NOW).lists.overdueCardIds).toHaveLength(20);
    expect(computeProjectFacts([col('c', 'Todo', many)], [], NOW).counts.overdue).toBe(30);
  });
  test('empty board gives zeros and the empty-project insight', () => {
    const f = computeProjectFacts([], [], NOW);
    expect(f.counts.total).toBe(0);
    expect(f.health.score).toBe(100);
  });
});

describe('time zone handling', () => {
  test('23:30 Prague local time is still "today" in Prague but already tomorrow in UTC terms of the next day', () => {
    const lateInPrague = new Date('2026-11-18T22:30:00Z'); // 23:30 Praha (CET, UTC+1)
    expect(todayInTz(lateInPrague, 'Europe/Prague')).toBe('2026-11-18');
    const afterMidnight = new Date('2026-11-18T23:30:00Z'); // 00:30 Praha
    expect(todayInTz(afterMidnight, 'Europe/Prague')).toBe('2026-11-19');
    expect(afterMidnight.toISOString().slice(0, 10)).toBe('2026-11-18'); // UTC by byl ještě včera
  });
  test('a card due "today" in Prague is not overdue at 23:30 but is the next minute after midnight', () => {
    const b = [col('c', 'Todo', [card('x', { dueDate: '2026-11-18' })])];
    expect(computeProjectFacts(b, [], new Date('2026-11-18T22:30:00Z')).counts.overdue).toBe(0);
    expect(computeProjectFacts(b, [], new Date('2026-11-18T23:30:00Z')).counts.overdue).toBe(1);
  });
});

describe('dueDateKey', () => {
  test('accepts ISO dates and datetimes', () => {
    expect(dueDateKey('2026-11-18')).toBe('2026-11-18');
    expect(dueDateKey('2026-11-18T10:30:00Z')).toBe('2026-11-18');
  });
  test.each(['', undefined, null, 'zítra', '18.11.2026', '2026-13-01', '2026-02-30', '2026-1-1'])('rejects %s', (v) => {
    expect(dueDateKey(v as string)).toBeNull();
  });
});

describe('recent changes from activity logs', () => {
  const logs = [
    act('a1', 'card_created', '2026-11-17T09:00:00Z'),
    act('a2', 'card_moved', '2026-11-16T09:00:00Z', { cardId: 't2', details: { from: 'K řešení', to: 'Hotovo' } }),
    act('a3', 'card_archived', '2026-11-15T09:00:00Z'),
    act('a4', 'member_added', '2026-11-14T09:00:00Z', { entityType: 'member' }),
    act('a5', 'card_created', '2026-10-01T09:00:00Z'), // mimo 7denní okno
    act('a6', 'card_moved', 'not-a-date'), // neplatné datum se ignoruje
  ];
  const f = computeProjectFacts([], logs, NOW);
  test('counts only events in the 7-day window', () => {
    expect(f.recentChanges.created).toBe(1);
    expect(f.recentChanges.movedToDone).toBe(1);
    expect(f.recentChanges.archived).toBe(1);
    expect(f.recentChanges.memberChanges).toBe(1);
  });
  test('entries are newest first and reference the activity id', () => {
    expect(f.recentChanges.entries.map((e) => e.activityId)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });
  test('completion stats of the existing layer are untouched', () => {
    expect(computeCompletionStats(board()).total).toBe(7);
  });
});
