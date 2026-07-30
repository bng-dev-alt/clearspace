import { describe, test, expect } from 'vitest';
import {
  computeCompletionStats,
  computeTeamWorkload,
  computeVelocity,
  computeBurndown,
} from '../lib/dashboardStats';
import type { Card, Column, ProjectActivityLog, TeamMember } from '../types/kanban';

function card(id: string, extra: Partial<Card> = {}): Card {
  return { id, title: `Karta ${id}`, details: '', ...extra };
}

function board(cols: { name: string; cards: Card[] }[]): Column[] {
  return cols.map((c, i) => ({ id: `column-${i + 1}`, name: c.name, cards: c.cards }));
}

function member(id: string, extra: Partial<TeamMember> = {}): TeamMember {
  return { id, fullName: id, initials: id.slice(0, 2).toUpperCase(), avatarColor: '#000000', createdAt: '', ...extra };
}

function activity(overrides: Partial<ProjectActivityLog>): ProjectActivityLog {
  return {
    id: `act-${Math.random()}`,
    projectId: 'p1',
    actorName: 'Test',
    actionType: 'card_created',
    entityType: 'task',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const NOW = new Date('2026-07-30T10:00:00Z');

describe('computeCompletionStats', () => {
  test('počítá poměr hotových karet, ignoruje archivované', () => {
    const stats = computeCompletionStats(
      board([
        { name: 'V průběhu', cards: [card('a'), card('b', { archived: true })] },
        { name: 'Hotovo', cards: [card('c'), card('d')] },
      ])
    );
    expect(stats.total).toBe(3); // b je archivovaná, nepočítá se
    expect(stats.done).toBe(2);
    expect(stats.rate).toBe(67);
  });

  test('prázdný board → rate 0, ne NaN', () => {
    const stats = computeCompletionStats(board([{ name: 'Nápady', cards: [] }]));
    expect(stats.total).toBe(0);
    expect(stats.rate).toBe(0);
  });
});

describe('computeTeamWorkload', () => {
  test('člen s výrazně víc kartami než průměr je overloaded', () => {
    const busy = member('busy');
    const idle = member('idle');
    const cols = board([
      {
        name: 'V průběhu',
        cards: [
          card('1', { assignees: [busy] }),
          card('2', { assignees: [busy] }),
          card('3', { assignees: [busy] }),
          card('4', { assignees: [busy] }),
          card('5', { assignees: [idle] }),
        ],
      },
    ]);
    const workload = computeTeamWorkload(cols, [busy, idle]);
    const busyEntry = workload.find((w) => w.member.id === 'busy')!;
    const idleEntry = workload.find((w) => w.member.id === 'idle')!;
    expect(busyEntry.assignedCount).toBe(4);
    expect(busyEntry.level).toBe('overloaded');
    expect(idleEntry.level).not.toBe('overloaded');
  });

  test('karty v Hotovo sloupci se do vytížení nepočítají', () => {
    const m = member('m');
    const cols = board([{ name: 'Hotovo', cards: [card('1', { assignees: [m] })] }]);
    const workload = computeTeamWorkload(cols, [m]);
    expect(workload[0].assignedCount).toBe(0);
    expect(workload[0].level).toBe('light');
  });
});

describe('computeVelocity', () => {
  test('počítá jen card_moved do Hotovo sloupce v rámci týdenního okna', () => {
    const logs: ProjectActivityLog[] = [
      activity({ actionType: 'card_moved', details: { to: 'Hotovo', from: 'V průběhu' }, createdAt: NOW.toISOString() }),
      activity({ actionType: 'card_moved', details: { to: 'V průběhu', from: 'Nápady' }, createdAt: NOW.toISOString() }), // nepočítá se, cíl není Hotovo
      activity({ actionType: 'card_created', createdAt: NOW.toISOString() }), // nepočítá se, jiný typ akce
    ];
    const velocity = computeVelocity(logs, 2, NOW);
    const total = velocity.reduce((sum, p) => sum + p.completed, 0);
    expect(total).toBe(1);
    expect(velocity[velocity.length - 1].completed).toBe(1);
  });
});

describe('computeBurndown', () => {
  test('vychází z aktuálního počtu a rekonstruuje zpět podle activity_logs', () => {
    const cols = board([{ name: 'V průběhu', cards: [card('1'), card('2')] }]);
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    const logs: ProjectActivityLog[] = [
      activity({ actionType: 'card_created', createdAt: yesterday.toISOString() }),
    ];
    const points = computeBurndown(cols, logs, 3, NOW);
    expect(points).toHaveLength(3);
    expect(points[2].remaining).toBe(2); // dnešek = aktuální pravda
    expect(points[1].remaining).toBe(2); // včera už karta vytvořená v ten den existovala
    expect(points[0].remaining).toBe(1); // předtím (2 dny zpět) ještě nebyla vytvořená
  });

  test('nikdy nevrátí záporný počet', () => {
    const cols = board([{ name: 'V průběhu', cards: [] }]);
    const logs: ProjectActivityLog[] = [
      activity({ actionType: 'card_archived', createdAt: NOW.toISOString() }),
      activity({ actionType: 'card_archived', createdAt: NOW.toISOString() }),
    ];
    const points = computeBurndown(cols, logs, 2, NOW);
    expect(points.every((p) => p.remaining >= 0)).toBe(true);
  });
});
