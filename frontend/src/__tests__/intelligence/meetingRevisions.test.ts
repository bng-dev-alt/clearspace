import { describe, test, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ inserts: [] as Array<{ table: string; row: Record<string, unknown> }>, insertError: null as null | { code: string; message: string } }));
vi.mock('../../lib/supabase', () => ({
  hasSupabaseConfig: true,
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => { h.inserts.push({ table, row }); return { error: h.insertError }; },
    }),
  },
}));

import { meetingService } from '../../services/meetingService';
import { parseTranscript, transcriptRevision, transcriptToText } from '../../lib/intelligence/transcript';

beforeEach(() => { h.inserts.length = 0; h.insertError = null; });

describe('transcriptToText', () => {
  test('round-trips through the paste parser (speaker names and texts survive)', () => {
    const t = parseTranscript('Petr Novák: Ahoj světe.\nHonza: Připravím migraci.', 'paste').transcript;
    const again = parseTranscript(transcriptToText(t), 'paste').transcript;
    expect(again.segments.map((s) => s.text)).toEqual(t.segments.map((s) => s.text));
    expect(again.speakers.map((s) => s.label)).toEqual(t.speakers.map((s) => s.label));
  });
  test('human-entered speaker names win over the labels in the text', () => {
    const t = parseTranscript('Petr: Ahoj světe.\nHonza: Nazdar všichni.', 'paste').transcript;
    const names = { [t.speakers[0].id]: 'Petr Novák' };
    expect(transcriptToText(t, names).split('\n')[0]).toBe('Petr Novák: Ahoj světe.');
  });
  test('segments without a speaker are plain lines', () => {
    const t = parseTranscript('Jen text bez mluvčího.', 'paste').transcript;
    expect(transcriptToText(t)).toBe('Jen text bez mluvčího.');
  });
});

describe('meetingService.addRevision', () => {
  const base = { meetingId: 'm1', projectId: 'p1' };
  test('stores a NEW immutable revision: source edit, parent, note, content hash as id', async () => {
    const parent = await transcriptRevision(parseTranscript('Petr: Ahoj světe.', 'paste').transcript);
    const out = await meetingService.addRevision({ ...base, text: 'Petr: Ahoj celý světe.', parentRevision: parent, note: '  oprava  ' });
    expect(h.inserts).toHaveLength(1);
    const row = h.inserts[0].row;
    expect(h.inserts[0].table).toBe('meeting_transcripts');
    expect(row).toMatchObject({ meeting_id: 'm1', project_id: 'p1', source: 'edit', parent_revision: parent, edit_note: 'oprava' });
    expect(row.revision).toBe(out.revision);
    expect(out.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(out.revision).not.toBe(parent);
    // the id is the content hash: editing and reverting gives the same id as before (idempotent, no duplicate row)
    const t2 = parseTranscript('Petr: Ahoj celý světe.', 'paste').transcript;
    expect(await transcriptRevision(t2)).toBe(out.revision);
  });
  test('identical content is refused as "unchanged" BEFORE any write', async () => {
    const t = parseTranscript('Petr: Ahoj světe.', 'paste').transcript;
    const parent = await transcriptRevision(t);
    await expect(meetingService.addRevision({ ...base, text: 'Petr: Ahoj světe.', parentRevision: parent })).rejects.toMatchObject({ code: 'unchanged' });
    expect(h.inserts).toHaveLength(0);
  });
  test('empty or invalid text is refused locally, nothing is written', async () => {
    await expect(meetingService.addRevision({ ...base, text: '   ', parentRevision: 'x'.repeat(64) })).rejects.toMatchObject({ code: 'empty' });
    expect(h.inserts).toHaveLength(0);
  });
  test('an existing revision (unique violation) is "unchanged"; the revision quota (PT429) is a readable quota error', async () => {
    h.insertError = { code: '23505', message: 'dup' };
    await expect(meetingService.addRevision({ ...base, text: 'Petr: Nový text zde.', parentRevision: 'x'.repeat(64) })).rejects.toMatchObject({ code: 'unchanged' });
    h.insertError = { code: 'PT429', message: 'Porada má maximální počet revizí přepisu (25).' };
    await expect(meetingService.addRevision({ ...base, text: 'Petr: Jiný text zde.', parentRevision: 'x'.repeat(64) })).rejects.toMatchObject({ code: 'quota', message: 'Porada má maximální počet revizí přepisu (25).' });
  });
  test('a long note is clipped to the database limit', async () => {
    await meetingService.addRevision({ ...base, text: 'Petr: Text s dlouhou poznámkou.', parentRevision: 'x'.repeat(64), note: 'n'.repeat(900) });
    expect((h.inserts[0].row.edit_note as string).length).toBe(500);
  });
});
