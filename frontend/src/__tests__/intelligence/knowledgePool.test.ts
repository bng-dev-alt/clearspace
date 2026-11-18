import { describe, test, expect, vi, beforeEach } from 'vitest';

/**
 * Approved knowledge (accepted/applied) must not depend on the limited pool of newer proposals: both the AI context
 * (server) and the Knowledge tab / freshness signature (client) read through fetchProjectItems.
 */
type Row = Record<string, unknown>;
interface Call { table: string; eq: Record<string, unknown>; inn: Record<string, unknown[]>; order: { col: string; opts: unknown }[]; limit: number | null }
const h = vi.hoisted(() => ({ rows: [] as Row[], calls: [] as unknown[], missingTable: false }));

/** Fake PostgREST builder for intelligence_items that really applies eq / in / order / limit. */
function fakeFrom(table: string) {
  const call: Call = { table, eq: {}, inn: {}, order: [], limit: null };
  (h.calls as Call[]).push(call);
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.eq = (c: string, v: unknown) => { call.eq[c] = v; return b; };
  b.in = (c: string, v: unknown[]) => { call.inn[c] = v; return b; };
  b.order = (col: string, opts: unknown) => { call.order.push({ col, opts }); return b; };
  b.limit = (n: number) => {
    call.limit = n;
    if (table !== 'intelligence_items') return Promise.resolve({ data: table === 'columns' ? [{ id: 'c1', name: 'Todo', position: 0 }] : [], error: null });
    if (h.missingTable) return Promise.resolve({ data: null, error: { code: 'PGRST205', message: 'no table' } });
    let out = h.rows.filter((r) => Object.entries(call.eq).every(([k, v]) => r[k] === v) && Object.entries(call.inn).every(([k, v]) => v.includes(r[k])));
    const key = call.order.map((o) => o.col);
    out = [...out].sort((x, y) => {
      for (const c of key) {
        const a = (x[c] ?? '') as string, z = (y[c] ?? '') as string;
        if (a !== z) return a < z ? 1 : -1; // all orders used here are descending
      }
      return 0;
    });
    return Promise.resolve({ data: out.slice(0, n), error: null });
  };
  b.maybeSingle = () => Promise.resolve({ data: table === 'projects' ? { id: 'p1', name: 'Alfa' } : null, error: null });
  return b;
}

vi.mock('../../lib/supabase', () => ({ hasSupabaseConfig: true, supabase: { from: fakeFrom, auth: { getSession: async () => ({ data: { session: null } }) }, rpc: async () => ({ data: null, error: null }) } }));
vi.mock('../../services/collaborationService', () => ({ collaborationService: { fetchActivities: async () => [] } }));

import { assembleContext, buildProjectContext } from '../../lib/intelligence/context';
import { APPROVED_ITEM_LIMIT, PROPOSAL_ITEM_LIMIT, fetchProjectItems } from '../../lib/intelligence/mappers';
import { intelligenceService } from '../../services/intelligenceService';
import { NOW } from './fixtures';

const pad = (n: number) => String(n).padStart(4, '0');
const row = (id: string, state: string, createdAt: string, extra: Row = {}): Row => ({
  id, project_id: 'p1', meeting_id: 'm1', kind: 'decision', text: `Text ${id}`, review_state: state, decided_at: null, created_at: createdAt, applied_card_id: null, ...extra,
});
/** 250 NEWER proposals + older approved items (an accepted decision, an applied action and an accepted item without decided_at). */
const seed = () => {
  h.rows = [
    ...Array.from({ length: 250 }, (_, i) => row(`prop-${pad(i)}`, 'proposed', `2026-11-${String(10 + Math.floor(i / 50)).padStart(2, '0')}T10:${String(i % 50).padStart(2, '0')}:00Z`, { kind: 'risk' })),
    row('old-accepted', 'accepted', '2026-01-02T10:00:00Z', { decided_at: '2026-01-03T10:00:00Z', text: 'Release posuneme na pátek.' }),
    row('old-applied', 'applied', '2026-01-04T10:00:00Z', { decided_at: '2026-01-05T10:00:00Z', kind: 'action_item', applied_card_id: 'k1', text: 'Honza připraví migraci.' }),
    row('old-undecided', 'accepted', '2026-01-01T10:00:00Z', { text: 'Starý závěr bez data rozhodnutí.' }),
  ];
  h.calls = [];
  h.missingTable = false;
};
beforeEach(seed);

const itemCalls = () => (h.calls as Call[]).filter((c) => c.table === 'intelligence_items');

describe('fetchProjectItems', () => {
  test('two queries with their own review_state filter and limit; approved ordered by decided_at desc (nulls last), then created_at desc', async () => {
    const items = await fetchProjectItems((await import('../../lib/supabase')).supabase as never, 'p1');
    const [approved, proposed] = itemCalls();
    expect(approved.eq).toEqual({ project_id: 'p1' });
    expect(approved.inn.review_state).toEqual(['accepted', 'applied']);
    expect(approved.order).toEqual([{ col: 'decided_at', opts: { ascending: false, nullsFirst: false } }, { col: 'created_at', opts: { ascending: false } }]);
    expect(approved.limit).toBe(APPROVED_ITEM_LIMIT);
    expect(proposed.eq).toEqual({ project_id: 'p1', review_state: 'proposed' });
    expect(proposed.inn).toEqual({});
    expect(proposed.limit).toBe(PROPOSAL_ITEM_LIMIT);
    // approved items survive 250 newer proposals; the proposal pool stays bounded
    expect(items.filter((i) => i.reviewState !== 'proposed').map((i) => i.id)).toEqual(['old-applied', 'old-accepted', 'old-undecided']);
    expect(items.filter((i) => i.reviewState === 'proposed')).toHaveLength(PROPOSAL_ITEM_LIMIT);
  });
  test('a missing table (older database) yields no items and never throws', async () => {
    h.missingTable = true;
    await expect(fetchProjectItems((await import('../../lib/supabase')).supabase as never, 'p1')).resolves.toEqual([]);
  });
});

describe('AI context (server)', () => {
  test('older accepted/applied decisions are in the rendered context even with >200 newer proposals', async () => {
    const db = { from: fakeFrom, } as never;
    const c = await buildProjectContext(db, 'p1', { purpose: 'chat', now: NOW });
    expect(c.rendered).toContain('Release posuneme na pátek.');
    expect(c.rendered).toContain('Honza připraví migraci.');
    expect(c.knowledgeItemIds.sort()).toEqual(['old-accepted', 'old-applied', 'old-undecided']);
    expect(c.facts.meetingDerived.pendingProposals).toBe(PROPOSAL_ITEM_LIMIT); // bounded pool
    expect(c.rendered).not.toContain('Text prop-'); // proposals are counted, never rendered as knowledge
  });
  test('assembleContext with only the approved items renders them (no dependence on proposals)', () => {
    const c = assembleContext({ project: { id: 'p1', name: 'A' }, columns: [], activities: [], items: [{ id: 'x', meetingId: null, kind: 'decision', text: 'Jen schválené.', reviewState: 'accepted', decidedAt: null, createdAt: '2026-01-01T00:00:00Z', appliedCardId: null }] }, { purpose: 'chat', now: NOW });
    expect(c.rendered).toContain('Jen schválené.');
  });
});

describe('Knowledge tab and freshness signature (client)', () => {
  test('listKnowledge lists older approved items, newest decision first, despite >200 newer proposals', async () => {
    const list = await intelligenceService.listKnowledge('p1');
    expect(list.map((i) => i.id)).toEqual(['old-applied', 'old-accepted', 'old-undecided']);
    expect(list.every((i) => i.reviewState === 'accepted' || i.reviewState === 'applied')).toBe(true);
    expect(itemCalls().map((c) => c.inn.review_state ?? c.eq.review_state)).toEqual([['accepted', 'applied'], 'proposed']);
  });
  test('currentSignature covers the same approved ids as the server (older approved items change it)', async () => {
    const a = await intelligenceService.currentSignature('p1', []);
    h.rows = h.rows.filter((r) => r.id !== 'old-accepted');
    const b = await intelligenceService.currentSignature('p1', []);
    expect(a).not.toBe(b);
  });
  test('missing table: empty knowledge, no throw', async () => {
    h.missingTable = true;
    await expect(intelligenceService.listKnowledge('p1')).resolves.toEqual([]);
  });
});
