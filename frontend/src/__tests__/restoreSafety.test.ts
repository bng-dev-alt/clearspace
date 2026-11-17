import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Column } from '../types/kanban';

/**
 * AI History restore must never delete or overwrite anything outside the one
 * project it was asked to restore. Supabase is mocked and records every call.
 */
const h = vi.hoisted(() => ({
  calls: [] as Array<{ kind: string; table?: string; args?: unknown }>,
  rpcError: null as null | { code: string; message: string },
}));

vi.mock('../lib/supabase', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const op of ['select', 'delete', 'update', 'insert', 'upsert']) {
      b[op] = (...args: unknown[]) => { h.calls.push({ kind: op, table, args }); return b; };
    }
    b.eq = (...args: unknown[]) => { h.calls.push({ kind: 'eq', table, args }); return b; };
    b.in = (...args: unknown[]) => { h.calls.push({ kind: 'in', table, args }); return b; };
    b.then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
    return b;
  };
  return {
    hasSupabaseConfig: true,
    supabase: {
      from: builder,
      rpc: async (name: string, args: unknown) => { h.calls.push({ kind: 'rpc', table: name, args }); return { data: {}, error: h.rpcError }; },
    },
  };
});

import { kanbanService } from '../services/kanbanService';
import { boardToRestorePayload } from '../services/boardMapping';

const board: Column[] = [
  { id: 'c1', name: 'Todo', cards: [
    { id: 'k1', title: 'Task', details: 'd', priority: 'High', archived: false,
      assignees: [
        { id: 'member-1', fullName: 'A', initials: 'A', avatarColor: '#fff', createdAt: '' },
        { id: 'member-fallback', fullName: 'Ghost', initials: 'G', avatarColor: '#fff', createdAt: '' },
      ],
      checklist: [{ id: 'cl1', text: 'x', completed: true }],
      comments: [{ id: 'cm1', authorName: 'A', content: 'hi', createdAt: '2026-01-01T00:00:00Z' }],
      activities: [{ id: 'ac1', text: 'did', createdAt: '2026-01-01T00:00:00Z' }] },
  ] },
];

describe('AI History restore safety', () => {
  beforeEach(() => { h.calls.length = 0; h.rpcError = null; });

  test('board restore = ONE atomic RPC for that project; no project is read, written or deleted', async () => {
    await kanbanService.restoreProjectSnapshot('proj-A', board);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ kind: 'rpc', table: 'restore_project_board' });
    expect((h.calls[0].args as { p_project_id: string }).p_project_id).toBe('proj-A');
    expect(h.calls.filter((c) => c.table === 'projects')).toHaveLength(0);
  });

  test('a stale projects list passed by an old caller cannot delete other projects', async () => {
    const stale = [{ id: 'proj-A', name: 'A' }] as never;
    // legacy 3-argument call shape
    await (kanbanService.restoreProjectSnapshot as unknown as (p: string, b: Column[], l: unknown) => Promise<void>)('proj-A', board, stale);
    expect(h.calls.some((c) => c.kind === 'delete')).toBe(false);
    expect(h.calls.some((c) => c.table === 'projects')).toBe(false);
  });

  test('a failing restore throws (no fake success) and surfaces that the board is unchanged', async () => {
    h.rpcError = { code: '23505', message: 'duplicate key' };
    await expect(kanbanService.restoreProjectSnapshot('proj-A', board)).rejects.toThrow('beze změny');
  });

  test('non-owner gets a clear message', async () => {
    h.rpcError = { code: '42501', message: 'x' };
    await expect(kanbanService.restoreProjectSnapshot('proj-A', board)).rejects.toThrow('vlastník');
  });

  test('restoring a project the AI CREATED deletes exactly that project and nothing else', async () => {
    await kanbanService.restoreProjectSnapshot('proj-new', null);
    const deletes = h.calls.filter((c) => c.kind === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].table).toBe('projects');
    const eqs = h.calls.filter((c) => c.kind === 'eq').map((c) => c.args);
    expect(eqs).toEqual([['id', 'proj-new']]);
    expect(h.calls.some((c) => c.kind === 'in')).toBe(false);
  });

  test('the default project can never be deleted by a restore', async () => {
    await expect(kanbanService.restoreProjectSnapshot('project-default-u1', null)).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });

  test('empty project id is refused', async () => {
    await expect(kanbanService.restoreProjectSnapshot('', board)).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });

  test('payload keeps children, skips the placeholder assignee and does not leak extra fields', () => {
    const p = boardToRestorePayload(board);
    const card = p.columns[0].cards[0];
    expect(card.assignee_ids).toEqual(['member-1']);
    expect(card.checklist).toHaveLength(1);
    expect(card.comments[0]).toMatchObject({ author_name: 'A', content: 'hi' });
    expect(card.activities).toHaveLength(1);
    expect(card.priority).toBe('High');
  });
});
