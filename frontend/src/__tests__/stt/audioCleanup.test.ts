import { describe, test, expect, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AudioCleanupError, deleteMeetingAudio, deleteProjectAudio, sweepProjectAudio } from '../../lib/stt/audioCleanup';

/**
 * Smazání zvuku bez poskytovatele přepisu (jen Storage + databáze). Žádný Soniox, žádný serverový klíč: tyto funkce musí fungovat
 * i při vypnutém přepisu a v prohlížeči (cesta /api/ai nemusí být vůbec dostupná).
 */
interface H {
  removed: string[];
  removeError: null | { message: string };
  listed: string[];
  order: string[];
  rpc: { name: string; args: Record<string, unknown> }[];
  rpcError: Record<string, { code: string }>;
  allPaths: string[];
  stray: string[];
  due: Record<string, unknown>[];
  orphans: { path: string }[];
  orphanDeletes: string[];
  audioMeetings: { id: string }[];
}
let h: H;
const M = { id: 'm1', project_id: 'pA', audio_path: 'pA/m1/a.mp3', audio_deleted_at: null as string | null, stt_state: 'none' };

function makeDb(): SupabaseClient {
  const builder = (table: string) => {
    let deleting = false;
    const result = () => {
      if (table === 'meetings') return { data: h.due.length ? h.due : h.audioMeetings, error: null };
      if (table === 'meeting_audio_orphans') return { data: h.orphans, error: null };
      return { data: [], error: null };
    };
    const b: Record<string, unknown> = {};
    b.select = () => b; b.eq = (c: string, v: string) => { if (deleting && c === 'path') h.orphanDeletes.push(v); return b; };
    b.not = () => b; b.lte = () => b; b.limit = () => b; b.delete = () => { deleting = true; return b; };
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
    return b;
  };
  return {
    from: builder,
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpc.push({ name, args }); h.order.push(name);
      if (h.rpcError[name]) return { data: null, error: h.rpcError[name] };
      if (name === 'list_project_audio') return { data: (args.p_unattached_only ? h.stray : h.allPaths).map((path) => ({ path })), error: null };
      return { data: null, error: null };
    },
    storage: { from: () => ({
      remove: async (p: string[]) => { h.order.push('remove'); if (!h.removeError) h.removed.push(...p); return { data: [], error: h.removeError }; },
      list: async () => ({ data: h.listed.map((name) => ({ name })), error: null }),
    }) },
  } as unknown as SupabaseClient;
}
beforeEach(() => { h = { removed: [], removeError: null, listed: [], order: [], rpc: [], rpcError: {}, allPaths: [], stray: [], due: [], orphans: [], orphanDeletes: [], audioMeetings: [] }; });

describe('deleteMeetingAudio', () => {
  test('removes the registered file and unattached files of the folder FIRST, marks the row afterwards', async () => {
    h.listed = ['stray.mp3'];
    await deleteMeetingAudio(makeDb(), M);
    expect(h.removed.sort()).toEqual(['pA/m1/a.mp3', 'pA/m1/stray.mp3']);
    expect(h.order).toEqual(['remove', 'mark_audio_deleted']);
  });
  test.each(['submitting', 'unknown', 'transcribing'])('refuses while the state is %s (a running job still needs the file)', async (stt_state) => {
    await expect(deleteMeetingAudio(makeDb(), { ...M, stt_state })).rejects.toMatchObject({ code: 'in_flight' });
    expect(h.removed).toHaveLength(0);
  });
  test('a Storage failure never marks the audio deleted', async () => {
    h.removeError = { message: 'x' };
    await expect(deleteMeetingAudio(makeDb(), M)).rejects.toBeInstanceOf(AudioCleanupError);
    expect(h.rpc.filter((c) => c.name === 'mark_audio_deleted')).toHaveLength(0);
  });
  test('a database refusal is reported, not hidden', async () => {
    h.rpcError.mark_audio_deleted = { code: '55000' };
    await expect(deleteMeetingAudio(makeDb(), M)).rejects.toMatchObject({ code: 'database' });
  });
  test('already deleted audio is a no-op for the row (idempotent)', async () => {
    await deleteMeetingAudio(makeDb(), { ...M, audio_path: null, audio_deleted_at: new Date().toISOString() });
    expect(h.rpc).toHaveLength(0);
  });
});

describe('sweepProjectAudio (no scheduler: runs when a member opens the project)', () => {
  test('removes due audio, orphans of deleted meetings and unattached uploads older than 24 h', async () => {
    h.due = [{ ...M, stt_state: 'failed' }];
    h.orphans = [{ path: 'pA/gone/x.mp3' }];
    h.stray = ['pA/m9/never-attached.mp3'];
    const r = await sweepProjectAudio(makeDb(), 'pA');
    expect(r).toEqual({ audioPurged: 1, orphansRemoved: 1, unattachedRemoved: 1 });
    expect(h.orphanDeletes).toEqual(['pA/gone/x.mp3']);
    expect(h.rpc.find((c) => c.name === 'list_project_audio')?.args).toEqual({ p_project: 'pA', p_unattached_only: true, p_older_than_hours: 24 });
  });
  test('a failing Storage call leaves orphans and strays queued for the next sweep (nothing is claimed removed)', async () => {
    h.orphans = [{ path: 'pA/gone/x.mp3' }];
    h.stray = ['pA/m9/never-attached.mp3'];
    h.removeError = { message: 'x' };
    expect(await sweepProjectAudio(makeDb(), 'pA')).toEqual({ audioPurged: 0, orphansRemoved: 0, unattachedRemoved: 0 });
    expect(h.orphanDeletes).toHaveLength(0);
  });
});

describe('C2: deleteProjectAudio (before a project is deleted)', () => {
  test('removes EVERY object of the project and marks the meetings, so nothing is left unreachable', async () => {
    h.allPaths = ['pA/m1/a.mp3', 'pA/m2/b.mp3', 'pA/m2/stray.mp3'];
    h.audioMeetings = [{ id: 'm1' }, { id: 'm2' }];
    expect(await deleteProjectAudio(makeDb(), 'pA')).toBe(3);
    expect(h.rpc[0].args).toEqual({ p_project: 'pA', p_unattached_only: false, p_older_than_hours: 0 });
    expect(h.removed).toHaveLength(3);
    expect(h.rpc.filter((c) => c.name === 'mark_audio_deleted').map((c) => c.args.p_meeting)).toEqual(['m1', 'm2']);
    expect(h.order.indexOf('remove')).toBeLessThan(h.order.indexOf('mark_audio_deleted'));
  });
  test('if Storage fails the project must NOT be deleted: the error is thrown', async () => {
    h.allPaths = ['pA/m1/a.mp3'];
    h.removeError = { message: 'x' };
    await expect(deleteProjectAudio(makeDb(), 'pA')).rejects.toMatchObject({ code: 'storage' });
  });
  test('if the listing fails the project must NOT be deleted', async () => {
    h.rpcError.list_project_audio = { code: 'XX000' };
    await expect(deleteProjectAudio(makeDb(), 'pA')).rejects.toMatchObject({ code: 'database' });
  });
  test('a project without audio costs one query and deletes nothing', async () => {
    expect(await deleteProjectAudio(makeDb(), 'pA')).toBe(0);
    expect(h.removed).toHaveLength(0);
  });
});
