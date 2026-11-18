import { describe, test, expect, vi, beforeEach } from 'vitest';

/** meetingService audio flow: consent first, content validated before any write, no orphan rows or files. Supabase and fetch are mocks. */
const h = vi.hoisted(() => ({
  log: [] as string[],
  insertError: null as null | { code: string },
  rpcErrors: {} as Record<string, { code: string }>,
  rpcData: {} as Record<string, unknown>,
  uploadError: null as null | { message: string },
  removeError: null as null | { message: string },
  removed: [] as string[],
  uploaded: [] as { path: string; type: string }[],
  deleted: 0,
  meetingRow: null as Record<string, unknown> | null,
  fetchRes: { ok: true, status: 200, body: {} as unknown },
}));
vi.mock('../../lib/supabase', () => ({
  hasSupabaseConfig: true,
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 't'.repeat(30) } } }) },
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => { h.log.push('insert'); return { data: h.insertError ? null : { id: 'mm' }, error: h.insertError }; } }) }),
      delete: () => ({ eq: async () => { h.log.push('delete'); h.deleted += 1; return { error: null }; } }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.meetingRow, error: null }) }) }),
    }),
    rpc: async (name: string) => { h.log.push(name); return { data: h.rpcData[name] ?? null, error: h.rpcErrors[name] ?? null }; },
    storage: {
      from: () => ({
        upload: async (path: string, _f: unknown, o: { contentType: string }) => { h.log.push('upload'); h.uploaded.push({ path, type: o.contentType }); return { error: h.uploadError }; },
        remove: async (paths: string[]) => { h.log.push('remove'); h.removed.push(...paths); return { error: h.removeError }; },
      }),
    },
  },
}));

import { meetingService } from '../../services/meetingService';

const file = (name: string, bytes: number[] | string, size?: number) => {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : Uint8Array.from(bytes);
  const f = new File([data], name, { type: 'application/octet-stream' });
  if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
  return f;
};
const MP3 = () => file('porada.mp3', [0x49, 0x44, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const input = (over: Record<string, unknown> = {}) => ({ projectId: 'pA', title: 'Audio', file: MP3(), consent: true, ...over }) as Parameters<typeof meetingService.createAudioMeeting>[0];

beforeEach(() => {
  h.log.length = 0; h.insertError = null; h.rpcErrors = {}; h.rpcData = {}; h.uploadError = null; h.removeError = null; h.removed.length = 0; h.uploaded.length = 0; h.deleted = 0; h.meetingRow = null;
  h.fetchRes = { ok: true, status: 200, body: {} };
  vi.stubGlobal('fetch', async () => ({ ok: h.fetchRes.ok, status: h.fetchRes.status, json: async () => h.fetchRes.body }));
});

describe('createAudioMeeting', () => {
  test('without consent NOTHING is written (no row, no upload)', async () => {
    await expect(meetingService.createAudioMeeting(input({ consent: false }))).rejects.toMatchObject({ code: 'consent_required' });
    expect(h.log).toEqual([]);
  });
  test.each([
    ['text renamed to .mp3', file('a.mp3', 'just text, not audio at all'), 'unrecognized'],
    ['unsupported extension', file('a.pdf', [0x49, 0x44, 0x33, 0, 0, 0]), 'unsupported_extension'],
    ['empty file', file('a.mp3', []), 'empty'],
    ['over 50 MB', file('a.mp3', [0x49, 0x44, 0x33, 0], 60_000_000), 'too_large'],
    ['a WAV named .mp3', file('a.mp3', 'RIFF\u0000\u0000\u0000\u0000WAVE'), 'content_mismatch'],
  ])('%s is refused before any write (client-side content check)', async (_n, f, code) => {
    await expect(meetingService.createAudioMeeting(input({ file: f }))).rejects.toMatchObject({ code });
    expect(h.log).toEqual([]);
  });
  test('order: row -> consent -> upload -> attach; the object path is project/meeting/uuid.ext with the checked MIME', async () => {
    h.rpcData.attach_meeting_audio = null;
    const r = await meetingService.createAudioMeeting(input({ clientDurationMs: 61_234.6 }));
    expect(r).toEqual({ meetingId: 'mm' });
    expect(h.log).toEqual(['insert', 'record_audio_consent', 'upload', 'attach_meeting_audio']);
    expect(h.uploaded[0].path).toMatch(/^pA\/mm\/[0-9a-f-]{36}\.mp3$/);
    expect(h.uploaded[0].type).toBe('audio/mpeg');
  });
  test('a failed consent record removes the empty meeting again and uploads nothing', async () => {
    h.rpcErrors.record_audio_consent = { code: '42501' };
    await expect(meetingService.createAudioMeeting(input())).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.log).toEqual(['insert', 'record_audio_consent', 'delete']);
  });
  test('a failed upload leaves no meeting behind', async () => {
    h.uploadError = { message: 'quota' };
    await expect(meetingService.createAudioMeeting(input())).rejects.toMatchObject({ code: 'upload' });
    expect(h.log).toEqual(['insert', 'record_audio_consent', 'upload', 'delete']);
  });
  test('if the database refuses the registration, the uploaded object is removed and the meeting deleted (no orphan file)', async () => {
    h.rpcErrors.attach_meeting_audio = { code: '22023' };
    await expect(meetingService.createAudioMeeting(input())).rejects.toMatchObject({ code: 'invalid' });
    expect(h.log).toEqual(['insert', 'record_audio_consent', 'upload', 'attach_meeting_audio', 'remove', 'delete']);
    expect(h.removed).toEqual([h.uploaded[0].path]);
  });
  test('a replaced file (previous path returned by the RPC) is removed from Storage', async () => {
    h.rpcData.attach_meeting_audio = 'pA/mm/old-file.mp3';
    await meetingService.uploadAudio({ meetingId: 'mm', projectId: 'pA', file: MP3(), format: 'mp3', mime: 'audio/mpeg', clientDurationMs: null });
    expect(h.removed).toEqual(['pA/mm/old-file.mp3']);
  });
  test('a quota error on meeting creation is readable', async () => {
    h.insertError = { code: 'PT429' };
    await expect(meetingService.createAudioMeeting(input())).rejects.toMatchObject({ code: 'quota' });
  });
});

describe('STT calls go through the server routes only', () => {
  test('start/sync/purge map server answers and errors to readable codes', async () => {
    h.fetchRes = { ok: true, status: 200, body: { started: true, state: 'transcribing' } };
    expect(await meetingService.startTranscription('pA', 'mm')).toEqual({ started: true, state: 'transcribing' });
    h.fetchRes = { ok: false, status: 409, body: { code: 'consent_required', error: 'Bez souhlasu' } };
    await expect(meetingService.startTranscription('pA', 'mm')).rejects.toMatchObject({ code: 'consent_required' });
    h.fetchRes = { ok: false, status: 503, body: { code: 'stt_disabled', error: 'vypnuto' } };
    await expect(meetingService.syncTranscription('pA', 'mm')).rejects.toMatchObject({ code: 'stt_disabled' });
    h.fetchRes = { ok: false, status: 403, body: null };
    await expect(meetingService.purgeAudio('pA', 'mm')).rejects.toMatchObject({ code: 'ai_disabled' }); // production firewall
  });
});

describe('remove: no orphaned audio', () => {
  const withAudio = () => { h.meetingRow = { id: 'mm', project_id: 'pA', title: 'x', occurred_at: '', source_kind: 'audio', status: 'transcribed', audio_path: 'pA/mm/f.mp3', audio_deleted_at: null, speaker_names: {} }; };
  test('a meeting with audio is purged through the server first, then deleted', async () => {
    withAudio();
    await meetingService.remove('mm');
    expect(h.log).toEqual(['delete']); // the purge ran through fetch (server route), then the row delete
    expect(h.deleted).toBe(1);
  });
  test('if the server route is unavailable the file is removed straight from Storage, then the meeting is deleted', async () => {
    withAudio();
    h.fetchRes = { ok: false, status: 503, body: { code: 'stt_disabled', error: 'x' } };
    await meetingService.remove('mm');
    expect(h.removed).toEqual(['pA/mm/f.mp3']);
    expect(h.log).toEqual(['remove', 'delete']);
  });
  test('if the file cannot be removed the meeting is NOT deleted (the file would be orphaned)', async () => {
    withAudio();
    h.fetchRes = { ok: false, status: 503, body: { code: 'stt_disabled', error: 'x' } };
    h.removeError = { message: 'x' };
    await expect(meetingService.remove('mm')).rejects.toMatchObject({ code: 'storage' });
    expect(h.deleted).toBe(0);
  });
  test('a text meeting is simply deleted', async () => {
    h.meetingRow = { id: 'mm', project_id: 'pA', title: 'x', occurred_at: '', source_kind: 'text', status: 'draft', audio_path: null, speaker_names: {} };
    await meetingService.remove('mm');
    expect(h.log).toEqual(['delete']);
  });
});
