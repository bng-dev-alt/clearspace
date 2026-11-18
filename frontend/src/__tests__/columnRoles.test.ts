import { describe, test, expect } from 'vitest';
import { columnRole, doneNameMatcher, inferColumnRole, isDoneColumn, computeProjectIntelligence } from '../lib/projectIntelligence';
import { computeProjectFacts } from '../lib/intelligence/facts';
import { computeCompletionStats, computeBurndown, computeVelocity } from '../lib/dashboardStats';
import type { Column, Card } from '../types/kanban';

const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, title: id, details: '', assignees: [], checklist: [], comments: [], ...extra }) as Card;
const NOW = new Date('2026-11-18T10:00:00Z');

describe('column roles (R6)', () => {
  test('explicit role wins over the name; no role falls back to the name heuristic', () => {
    expect(columnRole({ name: 'Hotovo', role: 'doing' })).toBe('doing');
    expect(columnRole({ name: 'Hotovo', role: null })).toBe('done');
    expect(columnRole({ name: 'Hotovo' })).toBe('done');
    expect(columnRole({ name: 'Zákazníci' })).toBeNull();
    expect(columnRole({ name: 'Zákazníci', role: 'done' })).toBe('done');
  });
  test.each([['Hotovo', 'done'], ['DONE', 'done'], ['Dokončeno', 'done'], ['K revizi', 'review'], ['Review', 'review'], ['Probíhá', 'doing'], ['In progress', 'doing'], ['K řešení', 'todo'], ['Backlog', 'todo'], ['Ostatní', null]])('inferColumnRole(%s) = %s', (n, r) => {
    expect(inferColumnRole(n)).toBe(r);
  });
  test('a column with an unusual name set to "done" counts as done everywhere', () => {
    const cols: Column[] = [
      { id: 'a', name: 'Backlog', cards: [card('1'), card('2')] },
      { id: 'b', name: 'Vyřízeno zákazníkem', role: 'done', cards: [card('3')] },
    ];
    expect(computeCompletionStats(cols)).toMatchObject({ total: 3, done: 1 });
    const f = computeProjectFacts(cols, [], NOW);
    expect(f.counts.done).toBe(1);
    expect(f.counts.active).toBe(2);
  });
  test('a column NAMED Hotovo but explicitly "doing" is NOT done (the human decided)', () => {
    const cols: Column[] = [{ id: 'a', name: 'Hotovo k nasazení', role: 'doing', cards: [card('1'), card('2')] }];
    expect(isDoneColumn(cols[0])).toBe(false);
    expect(computeCompletionStats(cols).done).toBe(0);
    expect(computeProjectFacts(cols, [], NOW).counts.done).toBe(0);
  });
  test('overdue is computed only for NOT done cards, by role', () => {
    const late = card('late', { dueDate: '2026-11-01' });
    const colsA: Column[] = [{ id: 'a', name: 'X', cards: [late] }];
    const colsB: Column[] = [{ id: 'a', name: 'X', role: 'done', cards: [late] }];
    expect(computeProjectFacts(colsA, [], NOW).counts.overdue).toBe(1);
    expect(computeProjectFacts(colsB, [], NOW).counts.overdue).toBe(0);
    expect(computeProjectIntelligence(colsB, NOW, '2026-11-18').health.score).toBeGreaterThanOrEqual(computeProjectIntelligence(colsA, NOW, '2026-11-18').health.score);
  });
  test('review role feeds the "in review" count', () => {
    const cols: Column[] = [{ id: 'r', name: 'Čeká na schválení', role: 'review', cards: [card('1')] }];
    expect(computeProjectFacts(cols, [], NOW).counts.inReview).toBe(1);
  });
  test('activity names resolve through roles for known columns and fall back to the name for renamed ones', () => {
    const cols: Column[] = [{ id: 'b', name: 'Vyřízeno', role: 'done', cards: [] }, { id: 'c', name: 'Hotovo', role: 'doing', cards: [] }];
    const m = doneNameMatcher(cols);
    expect(m('Vyřízeno')).toBe(true);
    expect(m(' vyřízeno ')).toBe(true);
    expect(m('Hotovo')).toBe(false); // known column, explicitly doing
    expect(m('Dokončeno')).toBe(true); // unknown historical name -> heuristic
    expect(m('Nápady')).toBe(false);
  });
  test('velocity and burndown honour roles through the matcher', () => {
    const cols: Column[] = [{ id: 'b', name: 'Vyřízeno', role: 'done', cards: [card('1')] }];
    const logs = [{ id: 'l', projectId: 'p', cardId: '1', actorName: 'A', actionType: 'card_moved', entityType: 'card', details: { from: 'Backlog', to: 'Vyřízeno' }, createdAt: '2026-11-17T09:00:00Z' }] as never;
    expect(computeVelocity(logs, 2, NOW).reduce((s, p) => s + p.completed, 0)).toBe(0); // default heuristic misses "Vyřízeno"
    expect(computeVelocity(logs, 2, NOW, doneNameMatcher(cols)).reduce((s, p) => s + p.completed, 0)).toBe(1);
    expect(computeBurndown(cols, logs, 3, NOW).length).toBe(3);
  });
});
