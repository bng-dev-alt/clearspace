import { describe, test, expect } from 'vitest';
import { assembleContext, REF_PATTERN } from '../../lib/intelligence/context';
import { computeProjectFacts, freshnessSignature, maxCardUpdatedAt, FACTS_VERSION, type ProjectItemLite } from '../../lib/intelligence/facts';
import { mapItemRows } from '../../lib/intelligence/mappers';
import { linkCitations } from '../../lib/intelligence/citations';
import type { SourceRecord } from '../../lib/intelligence/types';
import { computeProjectIntelligence } from '../../lib/projectIntelligence';
import { act, card, col, NOW } from './fixtures';

const item = (id: string, over: Partial<ProjectItemLite> = {}): ProjectItemLite => ({
  id, meetingId: 'm-1', kind: 'decision', text: `Závěr ${id}`, reviewState: 'accepted', decidedAt: '2026-11-10T10:00:00Z',
  createdAt: '2026-11-09T10:00:00Z', appliedCardId: null, ...over,
});
const board = () => [col('c1', 'K řešení', [card('k1', { title: 'Migrace', dueDate: '2026-11-10', tag: 'Blokováno' })]), col('c2', 'Hotovo', [])];

describe('meeting-derived facts (computed in code from review states)', () => {
  const items: ProjectItemLite[] = [
    item('d1'),
    item('d2', { decidedAt: '2026-09-01T10:00:00Z' }), // starší než 30 dní
    item('a1', { kind: 'action_item', reviewState: 'accepted' }),
    item('a2', { kind: 'action_item', reviewState: 'applied', appliedCardId: 'k1' }),
    item('a3', { kind: 'action_item', reviewState: 'proposed', decidedAt: null }),
    item('r1', { kind: 'risk' }),
    item('b1', { kind: 'blocker' }),
    item('q1', { kind: 'open_question' }),
  ];
  const f = computeProjectFacts(board(), [], NOW, undefined, items);
  test('counts', () => {
    expect(f.meetingDerived).toMatchObject({ pendingProposals: 1, acceptedNotApplied: 1, decisionsLast30d: 1, openQuestions: 1, risks: 1, blockers: 1 });
    expect(f.meetingDerived.recentDecisionItemIds).toEqual(['d1']);
  });
  test('proposed (unreviewed) AI output never counts as knowledge', () => {
    const only = computeProjectFacts(board(), [], NOW, undefined, [item('p', { reviewState: 'proposed', kind: 'decision', decidedAt: null })]);
    expect(only.meetingDerived).toMatchObject({ pendingProposals: 1, decisionsLast30d: 0 });
  });
  test('no items -> zeros; facts version bumped because the shape changed', () => {
    expect(computeProjectFacts(board(), [], NOW).meetingDerived).toMatchObject({ pendingProposals: 0, acceptedNotApplied: 0, decisionsLast30d: 0 });
    expect(FACTS_VERSION).toBe('facts-2');
  });
  test('deterministic health is IDENTICAL with and without meeting data (score consistency)', () => {
    const without = computeProjectFacts(board(), [], NOW).health;
    expect(f.health).toEqual(without);
    expect(f.health.score).toBe(computeProjectIntelligence(board(), NOW, f.today).health.score);
  });
});

describe('mapItemRows', () => {
  test('keeps valid rows, skips incomplete rows and unknown kinds/states (superseded/rejected are not knowledge)', () => {
    const rows = [
      { id: 'a', text: 't', kind: 'decision', review_state: 'accepted', created_at: '2026-11-01T00:00:00Z', meeting_id: 'm' },
      { id: 'b', text: 't', kind: 'decision', review_state: 'rejected', created_at: '2026-11-01T00:00:00Z' },
      { id: 'c', text: 't', kind: 'weird', review_state: 'accepted', created_at: '2026-11-01T00:00:00Z' },
      { text: 'no id', kind: 'risk', review_state: 'accepted', created_at: 'x' },
    ];
    expect(mapItemRows(rows).map((r) => r.id)).toEqual(['a']);
    expect(mapItemRows(null)).toEqual([]);
  });
});

describe('context: accepted meeting conclusions are citable sources', () => {
  const data = (items: ProjectItemLite[]) => ({ project: { id: 'p1', name: 'P' }, columns: board(), activities: [act('a1', 'card_created', '2026-11-17T00:00:00Z')], items });
  test('accepted/applied items become item: sources and appear in the prompt block; proposed ones do not', () => {
    const c = assembleContext(data([item('d1'), item('a1', { kind: 'action_item', reviewState: 'applied', appliedCardId: 'k1' }), item('p1', { reviewState: 'proposed', kind: 'risk', decidedAt: null })]), { purpose: 'brief', now: NOW });
    const refs = c.sources.map((s) => s.ref);
    expect(refs).toContain('item:d1');
    expect(refs).toContain('item:a1');
    expect(refs).not.toContain('item:p1');
    expect(c.rendered).toContain('[item:d1] decision: Závěr d1');
    expect(c.rendered).toContain('Přijaté závěry z porad (schváleno člověkem)');
    expect(c.rendered).not.toContain('Závěr p1');
    expect(c.knowledgeItemIds.sort()).toEqual(['a1', 'd1']);
    for (const s of c.sources) expect(REF_PATTERN.test(s.ref)).toBe(true);
    expect(c.sources.find((s) => s.ref === 'item:a1')!.meta).toMatchObject({ meetingId: 'm-1', appliedCardId: 'k1', reviewState: 'applied' });
  });
  test('accepting another item changes the fingerprint (stale brief); the facts mention the meeting counts', () => {
    const a = assembleContext(data([item('d1')]), { purpose: 'brief', now: NOW });
    const b = assembleContext(data([item('d1'), item('d2')]), { purpose: 'brief', now: NOW });
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.rendered).toContain('"meetingDerived"');
  });
  test('under budget pressure items are kept before ordinary recent cards', () => {
    const many = Array.from({ length: 80 }, (_, i) => card(`n${i}`, { title: `Karta ${i}`, details: 'x'.repeat(400), updatedAt: '2026-11-17T00:00:00Z' }));
    const c = assembleContext({ project: { id: 'p1', name: 'P' }, columns: [col('c', 'Todo', many)], activities: [], items: [item('d1')] }, { purpose: 'meeting', now: NOW, budgetChars: 5_000 });
    expect(c.sources.map((s) => s.ref)).toContain('item:d1');
  });
});

describe('freshnessSignature', () => {
  const sig = (cols = board(), items: ProjectItemLite[] = [], logs = [] as ReturnType<typeof act>[], now = NOW) => {
    const f = computeProjectFacts(cols, logs, now, undefined, items);
    return freshnessSignature(f, { maxCardUpdatedAt: maxCardUpdatedAt(cols), knowledgeItemIds: items.filter((i) => i.reviewState !== 'proposed').map((i) => i.id) });
  };
  test('identical data -> identical signature (server and client agree)', () => expect(sig()).toBe(sig()));
  test('changes when a card is added, moved to Done, edited, or when a conclusion is accepted', () => {
    const base = sig();
    const added = board(); added[0].cards.push(card('k2'));
    expect(sig(added)).not.toBe(base);
    const moved = board(); moved[1].cards.push(moved[0].cards.pop()!);
    expect(sig(moved)).not.toBe(base);
    const edited = board(); edited[0].cards[0].updatedAt = '2026-11-18T09:00:00Z';
    expect(sig(edited)).not.toBe(base);
    expect(sig(board(), [item('d1')])).not.toBe(base);
  });
  test('changes at midnight Prague time (overdue cards may change)', () => {
    expect(sig(board(), [], [], new Date('2026-11-18T22:30:00Z'))).not.toBe(sig(board(), [], [], new Date('2026-11-18T23:30:00Z')));
  });
  test('maxCardUpdatedAt picks the newest timestamp (archived cards count: archiving is a change)', () => {
    const cols = [col('c', 'T', [card('a', { updatedAt: '2026-11-01T00:00:00Z' }), card('b', { updatedAt: '2026-11-05T00:00:00Z', archived: true })])];
    expect(maxCardUpdatedAt(cols)).toBe('2026-11-05T00:00:00Z');
    expect(maxCardUpdatedAt([])).toBeNull();
  });
});

describe('chat citations (linkCitations)', () => {
  const sources: SourceRecord[] = [
    { ref: 'card:k1', kind: 'card', text: 'Migrace', label: 'Migrace' },
    { ref: 'comment:cm1', kind: 'comment', text: 'komentář', label: 'Jana', meta: { cardId: 'k1' } },
    { ref: 'item:d1', kind: 'item', text: 'Release v pátek', label: 'Release v pátek', meta: { meetingId: 'm-1', appliedCardId: null } },
  ];
  test('valid refs are numbered in order of first use and reused; the text keeps its sentences', () => {
    const r = linkCitations('Migrace je blokovaná [card:k1]. Jana to potvrdila [comment:cm1], viz [card:k1].', sources);
    expect(r.content).toBe('Migrace je blokovaná [1]. Jana to potvrdila [2], viz [1].');
    expect(r.citations.map((c) => [c.n, c.ref, c.cardId])).toEqual([[1, 'card:k1', 'k1'], [2, 'comment:cm1', 'k1']]);
  });
  test('FAKE refs (not in the context) are removed instead of being turned into citations', () => {
    const r = linkCitations('Podle [card:neexistuje] to platí [item:fake]. Pravda [item:d1].', sources);
    expect(r.citations.map((c) => c.ref)).toEqual(['item:d1']);
    expect(r.content).not.toMatch(/neexistuje|fake/);
    expect(r.content).toContain('[1]');
  });
  test('meeting conclusions link to their meeting', () => {
    expect(linkCitations('[item:d1]', sources).citations[0]).toMatchObject({ kind: 'item', meetingId: 'm-1', cardId: null });
  });
  test('text without citations is returned unchanged; brackets that are not refs are kept', () => {
    expect(linkCitations('Bez citací [poznámka] a [1].', sources)).toEqual({ content: 'Bez citací [poznámka] a [1].', citations: [] });
  });
  test('malformed refs are never resolved', () => {
    expect(linkCitations('[card:] [card:k1#x] [meeting:m1]', sources).citations).toEqual([]);
  });
});
