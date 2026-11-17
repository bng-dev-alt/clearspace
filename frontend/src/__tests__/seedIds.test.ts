import { describe, test, expect, vi, beforeEach } from 'vitest';

/**
 * Regrese: columns.id / cards.id jsou globální primární klíče (text, od klienta).
 * Výchozí projekt dřív dostával holé 'column-1' / 'card-1', takže druhý
 * uživatel narazil na kolizi klíčů a jeho board se nenaseedoval.
 */

const inserts: Record<string, Array<Record<string, unknown>>> = {};

vi.mock('../lib/supabase', () => {
  const chain = (table: string) => ({
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    delete: () => ({ in: () => Promise.resolve({ error: null }) }),
    insert: (rows: Array<Record<string, unknown>> | Record<string, unknown>) => {
      inserts[table] = [...(inserts[table] ?? []), ...(Array.isArray(rows) ? rows : [rows])];
      return Promise.resolve({ error: null });
    },
  });
  return { hasSupabaseConfig: true, supabase: { from: (t: string) => chain(t) } };
});

import { kanbanService } from '../services/kanbanService';
import { buildSeedBoard, scopedSeedId } from '../services/storage/seedBoard';
import { localStore } from '../services/storage/localStore';

describe('seed IDs are unique per project', () => {
  beforeEach(() => {
    for (const k of Object.keys(inserts)) delete inserts[k];
    localStorage.clear();
  });

  test('scopedSeedId prefixes from the left (endsWith lookups keep working)', () => {
    const id = scopedSeedId('project-default-u1', 'column-3');
    expect(id).toBe('project-default-u1-column-3');
    expect(id.endsWith('column-3')).toBe(true);
  });

  test('buildSeedBoard scopes column AND card ids; empty variant has no cards', () => {
    const withCards = buildSeedBoard('p1', true);
    expect(withCards.every((c) => c.id.startsWith('p1-'))).toBe(true);
    const cards = withCards.flatMap((c) => c.cards);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.id.startsWith('p1-'))).toBe(true);
    expect(buildSeedBoard('p1', false).flatMap((c) => c.cards)).toHaveLength(0);
  });

  test('two users seeding their default project produce no duplicate primary keys', async () => {
    await kanbanService.seedInitialData('project-default-user-a');
    await kanbanService.seedInitialData('project-default-user-b');

    const colIds = inserts.columns.map((r) => r.id as string);
    const cardIds = inserts.cards.map((r) => r.id as string);
    expect(new Set(colIds).size).toBe(colIds.length);
    expect(new Set(cardIds).size).toBe(cardIds.length);
    expect(colIds.every((id) => !/^column-\d+$/.test(id))).toBe(true);
    expect(cardIds.every((id) => !/^card-\d+$/.test(id))).toBe(true);
  });

  test('seeded cards point at the seeded (scoped) column of the same project', async () => {
    await kanbanService.seedInitialData('project-default-user-a');
    const colIds = new Set(inserts.columns.map((r) => r.id as string));
    for (const card of inserts.cards) {
      expect(colIds.has(card.column_id as string)).toBe(true);
    }
  });

  test('empty seed (isEmpty) creates columns only', async () => {
    await kanbanService.seedInitialData('project-default-user-a', true);
    expect(inserts.columns).toHaveLength(5);
    expect(inserts.cards ?? []).toHaveLength(0);
  });

  test('demo (localStorage) boards keep the plain ids that e2e and the stats code rely on', () => {
    const board = localStore.getBoard('project-default-user-a');
    expect(board.map((c) => c.id)).toEqual(['column-1', 'column-2', 'column-3', 'column-4', 'column-5']);
  });
});
