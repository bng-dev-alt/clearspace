import { describe, test, expect } from 'vitest';
import { normalizeSonioxTokens, NormalizeError, SPLIT_AFTER_MS } from '../../lib/stt/normalize';
import { DEFAULT_TURNS, tokensFor } from '../../../e2e/support/fake-soniox.mjs';
import { parseTranscript, transcriptRevision } from '../../lib/intelligence/transcript';

const tok = (text: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({ text, start_ms: start, end_ms: end, confidence: 0.9, ...extra });

describe('normalizeSonioxTokens: tokens -> transcript', () => {
  test('sub-word tokens are joined VERBATIM (their own leading spaces), never re-spaced', async () => {
    const n = await normalizeSonioxTokens([tok('Hel', 0, 100, { speaker: '1' }), tok('lo', 100, 200, { speaker: '1' }), tok(' wor', 200, 300, { speaker: '1' }), tok('ld.', 300, 400, { speaker: '1' })]);
    expect(n.transcript.segments).toHaveLength(1);
    expect(n.transcript.segments[0].text).toBe('Hello world.');
  });
  test('the realistic fake output: 3 turns, speakers mapped to S1/S2, Czech text intact', async () => {
    const n = await normalizeSonioxTokens(tokensFor(DEFAULT_TURNS));
    expect(n.transcript.segments.map((s) => s.speakerId)).toEqual(['S1', 'S2', 'S1']);
    expect(n.transcript.segments[0].text).toBe('Dobrý den, začneme releasem. Rozhodli jsme, že release posuneme na pátek.');
    expect(n.transcript.segments[1].text).toBe('Honza připraví migraci databáze do 25. listopadu, to slibuji.');
    expect(n.transcript.speakers).toEqual([{ id: 'S1', label: 'Mluvčí 1', displayName: null }, { id: 'S2', label: 'Mluvčí 2', displayName: null }]);
    expect(n.transcript.segments.every((s) => (s.startMs ?? 0) <= (s.endMs ?? 0))).toBe(true);
  });
  test('the model never names speakers: displayName is always null', async () => {
    const n = await normalizeSonioxTokens(tokensFor(DEFAULT_TURNS));
    expect(n.transcript.speakers.every((s) => s.displayName === null)).toBe(true);
  });
  test('without diarization there are no speakers and speakerId is null', async () => {
    const n = await normalizeSonioxTokens([tok('Ahoj', 0, 100), tok(' světe', 100, 200)]);
    expect(n.transcript.speakers).toEqual([]);
    expect(n.transcript.segments[0]).toMatchObject({ speakerId: null, text: 'Ahoj světe' });
  });
  test('speaker ids: numeric strings map to S<n>, others by first appearance; no collisions', async () => {
    const n = await normalizeSonioxTokens([tok('a', 0, 1, { speaker: '10' }), tok('b', 1, 2, { speaker: '2' }), tok('c', 2, 3, { speaker: 'X' }), tok('d', 3, 4, { speaker: 'Y' })]);
    const ids = n.transcript.speakers.map((s) => s.id);
    expect(ids[0]).toBe('S10');
    expect(ids[1]).toBe('S2');
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('markers <end>/<fin>, empty tokens, audio events and junk entries are dropped', async () => {
    const n = await normalizeSonioxTokens([tok('Ahoj', 0, 100), tok('<end>', 100, 100), tok('', 100, 100), tok('<fin>', 100, 100), tok('[music]', 100, 200, { is_audio_event: true }), null, 42, { text: 5 }, tok(' světe', 200, 300)]);
    expect(n.transcript.segments[0].text).toBe('Ahoj světe');
    expect(n.coverage.tokenCount).toBe(2);
  });
  test('control characters are removed and whitespace collapsed', async () => {
    const n = await normalizeSonioxTokens([tok('Ahoj\u0000\u0007', 0, 1), tok('\n  světe', 1, 2)]);
    expect(n.transcript.segments[0].text).toBe('Ahoj světe');
  });
  test('times: end is clamped to start, missing times continue from the previous token', async () => {
    const n = await normalizeSonioxTokens([tok('a', 500, 100), { text: ' b' }, tok(' c', 900, 1000)]);
    const s = n.transcript.segments[0];
    expect(s.startMs).toBe(500);
    expect(s.endMs).toBe(1000);
    expect(n.coverage.durationMs).toBe(1000);
  });
  test('a long monologue is split at a SENTENCE end once it exceeds 30 s or 600 chars, so evidence stays precise', async () => {
    const toks: ReturnType<typeof tok>[] = [];
    let t = 0;
    for (let i = 0; i < 40; i++) {
      toks.push(tok(i === 39 ? ' konec.' : i % 8 === 7 ? ' věta.' : ' slovo', t, t + 1500, { speaker: '1' }));
      t += 1500;
    }
    const n = await normalizeSonioxTokens(toks);
    expect(n.transcript.segments.length).toBeGreaterThan(1);
    // every cut is after a sentence end
    for (const s of n.transcript.segments.slice(0, -1)) expect(s.text).toMatch(/\.$/);
    for (const s of n.transcript.segments) expect((s.endMs ?? 0) - (s.startMs ?? 0)).toBeLessThan(SPLIT_AFTER_MS + 15_000);
  });
  test('a monologue without any sentence end is cut at the hard limit (1200 chars)', async () => {
    const toks = Array.from({ length: 400 }, (_, i) => tok(' slovo', i * 100, i * 100 + 90, { speaker: '1' }));
    const n = await normalizeSonioxTokens(toks);
    expect(n.transcript.segments.length).toBeGreaterThan(1);
    expect(Math.max(...n.transcript.segments.map((s) => s.text.length))).toBeLessThanOrEqual(1300);
  });
  test('a short turn is never split; a speaker change always starts a new segment', async () => {
    const n = await normalizeSonioxTokens([tok('Ano.', 0, 100, { speaker: '1' }), tok(' Ne.', 100, 200, { speaker: '2' }), tok(' Ano.', 200, 300, { speaker: '1' })]);
    expect(n.transcript.segments.map((s) => s.text)).toEqual(['Ano.', 'Ne.', 'Ano.']);
  });
  test('segment ids satisfy the database rules (unique, no whitespace or # [ ]) even when two segments start at the same ms', async () => {
    const n = await normalizeSonioxTokens([tok('a', 0, 10, { speaker: '1' }), tok('b', 0, 10, { speaker: '2' }), tok('c', 0, 10, { speaker: '1' })]);
    const ids = n.transcript.segments.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[^\s\]\[#]{1,200}$/);
  });
  test('the dominant language of a segment is kept', async () => {
    const n = await normalizeSonioxTokens([tok('Ahoj', 0, 1, { speaker: '1', language: 'cs' }), tok(' meeting', 1, 2, { speaker: '1', language: 'en' }), tok(' dnes', 2, 3, { speaker: '1', language: 'cs' })]);
    expect(n.transcript.segments[0].language).toBe('cs');
  });
  test('gaps longer than 2 s are MARKED in coverage, never filled', async () => {
    const n = await normalizeSonioxTokens([tok('a', 0, 500), tok(' b', 500, 1000), tok(' c', 6000, 6500)]);
    expect(n.coverage).toMatchObject({ gapCount: 1, gaps: [{ startMs: 1000, endMs: 6000 }], tokenCount: 3, durationMs: 6500 });
    expect(n.transcript.segments[0].text).toBe('a b c');
  });
  test('char count equals the sum of the segment texts', async () => {
    const n = await normalizeSonioxTokens(tokensFor(DEFAULT_TURNS));
    expect(n.charCount).toBe(n.transcript.segments.reduce((s, x) => s + x.text.length, 0));
  });
});

describe('revision and compatibility', () => {
  test('the revision is the content hash: stable for the same tokens, different when the text differs', async () => {
    const a = await normalizeSonioxTokens(tokensFor(DEFAULT_TURNS));
    const b = await normalizeSonioxTokens(tokensFor(DEFAULT_TURNS));
    const c = await normalizeSonioxTokens(tokensFor([{ speaker: '1', text: 'Úplně jiný text porady.' }]));
    expect(a.revision).toBe(b.revision);
    expect(a.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(a.revision).not.toBe(c.revision);
    expect(a.revision).toBe(await transcriptRevision(a.transcript));
  });
  test('the machine transcript behaves like any other transcript: the text editor round-trips it', async () => {
    const n = await normalizeSonioxTokens(tokensFor(DEFAULT_TURNS));
    const { transcriptToText } = await import('../../lib/intelligence/transcript');
    const again = parseTranscript(transcriptToText(n.transcript), 'paste').transcript;
    expect(again.segments.map((s) => s.text)).toEqual(n.transcript.segments.map((s) => s.text));
  });
});

describe('refusals', () => {
  test.each([[[]], [null], ['x'], [[tok('<end>', 0, 0), tok('<fin>', 0, 0)]], [[tok('   ', 0, 1)]]])('no speech: %j', async (input) => {
    await expect(normalizeSonioxTokens(input)).rejects.toBeInstanceOf(NormalizeError);
    await expect(normalizeSonioxTokens(input)).rejects.toMatchObject({ code: 'empty' });
  });
  test('more than 400 000 characters is refused', async () => {
    const big = Array.from({ length: 450 }, (_, i) => tok('x'.repeat(1000), i * 10, i * 10 + 5, { speaker: String((i % 2) + 1) }));
    await expect(normalizeSonioxTokens(big)).rejects.toMatchObject({ code: 'too_long' });
  });
});
