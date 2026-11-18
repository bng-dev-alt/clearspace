import { describe, test, expect } from 'vitest';
import {
  MAX_TRANSCRIPT_CHARS,
  parseTranscript,
  sourceFromFilename,
  TranscriptParseError,
  transcriptRevision,
} from '../../lib/intelligence/transcript';

const fails = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TranscriptParseError);
    expect((e as TranscriptParseError).code).toBe(code);
    return;
  }
  throw new Error(`expected TranscriptParseError(${code})`);
};

describe('sourceFromFilename', () => {
  test.each([['porada.txt', 'txt'], ['Zapis.MD', 'md'], ['x.markdown', 'md'], ['t.srt', 'srt'], ['t.vtt', 'vtt']])('%s -> %s', (n, t) => {
    expect(sourceFromFilename(n)).toBe(t);
  });
  test.each(['porada.pdf', 'audio.mp3', 'noext', 'x.docx', ''])('rejects unsupported %s', (n) => {
    expect(sourceFromFilename(n)).toBeNull();
  });
});

describe('pasted / TXT transcripts', () => {
  test('"Name: text" lines become segments with speakers (names only from the source)', () => {
    const r = parseTranscript('Petr Novák: Dobrý den.\nJana: Ahoj, začneme.\nPetr Novák: Super.', 'paste');
    expect(r.transcript.segments.map((s) => s.id)).toEqual(['seg-0', 'seg-1', 'seg-2']);
    expect(r.transcript.speakers.map((s) => [s.id, s.label, s.displayName])).toEqual([['S1', 'Petr Novák', null], ['S2', 'Jana', null]]);
    expect(r.transcript.segments[2].speakerId).toBe('S1');
    expect(r.transcript.segments[0].text).toBe('Dobrý den.');
    expect(r.charCount).toBe(r.transcript.segments.reduce((n, s) => n + s.text.length, 0));
  });
  test('speakers are matched case- and diacritics-insensitively', () => {
    const r = parseTranscript('Novák: a\nNOVAK: b', 'txt');
    expect(r.transcript.speakers).toHaveLength(1);
  });
  test('without timestamps times are NULL (never invented) and a warning is given', () => {
    const r = parseTranscript('Petr: Ahoj.', 'paste');
    expect(r.transcript.segments[0]).toMatchObject({ startMs: null, endMs: null });
    expect(r.warnings.join(' ')).toMatch(/časov/);
  });
  test('inline timestamps [mm:ss] / h:mm:ss are honoured; end = next start', () => {
    const r = parseTranscript('[00:05] Petr: První.\n[01:02:03] Jana: Druhá.', 'paste');
    expect(r.transcript.segments[0]).toMatchObject({ startMs: 5000, endMs: 3723000 });
    expect(r.transcript.segments[1]).toMatchObject({ startMs: 3723000, endMs: null });
    expect(r.warnings.join(' ')).not.toMatch(/časov/);
  });
  test('plain paragraphs without names: blank lines split segments, line breaks inside join', () => {
    const r = parseTranscript('První řádek\ndruhý řádek.\n\nNový odstavec.', 'paste');
    expect(r.transcript.segments.map((s) => s.text)).toEqual(['První řádek druhý řádek.', 'Nový odstavec.']);
    expect(r.transcript.speakers).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/jména mluvčích/);
  });
  test('a labelled line followed by an unlabelled line continues the same segment', () => {
    const r = parseTranscript('Petr: Začnu tím,\nže release posuneme.', 'paste');
    expect(r.transcript.segments).toHaveLength(1);
    expect(r.transcript.segments[0].text).toBe('Začnu tím, že release posuneme.');
  });
  test('"Riziko: ..." style labels with lowercase-only or too long labels are not speakers', () => {
    const r = parseTranscript('poznámka: toto není mluvčí\nCelkem dlouhý popisek který nemá být jméno mluvčího vůbec nikdy: text', 'paste');
    expect(r.transcript.speakers).toEqual([]);
  });
  test('CRLF, BOM and control characters are normalised', () => {
    const r = parseTranscript('﻿Petr: A\r\nJana: B\u0000\u0007', 'paste');
    expect(r.transcript.segments.map((s) => s.text)).toEqual(['A', 'B']);
  });
  test('very long paragraph is split on sentence boundaries so evidence stays precise', () => {
    const sentence = 'Toto je jedna celkem dlouhá věta o projektu. ';
    const r = parseTranscript(`Petr: ${sentence.repeat(60)}`, 'paste');
    expect(r.transcript.segments.length).toBeGreaterThan(2);
    for (const s of r.transcript.segments) {
      expect(s.text.length).toBeLessThanOrEqual(1200);
      expect(s.speakerId).toBe('S1');
    }
    expect(r.transcript.segments.map((s) => s.id)).toEqual(r.transcript.segments.map((_, i) => `seg-${i}`));
  });
  test('a long text without any punctuation is hard-split by words', () => {
    const r = parseTranscript(`Petr: ${'slovo '.repeat(500)}`, 'paste');
    expect(r.transcript.segments.length).toBeGreaterThan(1);
    expect(Math.max(...r.transcript.segments.map((s) => s.text.length))).toBeLessThanOrEqual(1200);
  });
});

describe('empty and oversized input', () => {
  test.each(['', '   ', '\n\n\t\n', '﻿'])('empty input %j is refused', (v) => fails(() => parseTranscript(v, 'paste'), 'empty'));
  test('over 400k characters is refused', () => {
    fails(() => parseTranscript(`Petr: ${'a'.repeat(MAX_TRANSCRIPT_CHARS + 10)}`, 'txt'), 'too_long');
  });
  test('absurdly large input is refused before parsing', () => {
    fails(() => parseTranscript('x'.repeat(MAX_TRANSCRIPT_CHARS * 2 + 1), 'txt'), 'too_long');
  });
});

describe('Markdown', () => {
  test('headings, bullets, emphasis and quotes are stripped; speaker lines survive', () => {
    const md = '# Zápis z porady\n\n- **Petr**: Dnes řešíme release.\n> Jana: Souhlasím.\n\n## Další\n* Honza: Připravím migraci.';
    const r = parseTranscript(md, 'md');
    expect(r.transcript.segments.map((s) => s.text)).toEqual(['Zápis z porady', 'Dnes řešíme release.', 'Souhlasím.', 'Další', 'Připravím migraci.']);
    expect(r.transcript.speakers.map((s) => s.label)).toEqual(['Petr', 'Jana', 'Honza']);
  });
});

describe('SRT', () => {
  const srt = `1
00:00:01,000 --> 00:00:04,500
Petr: Dobrý den všem.

2
00:00:05,000 --> 00:00:08,000
Jana: Začneme releasem.
Máme dvě témata.

3
00:01:00,250 --> 00:01:02,000
Bez mluvčího.
`;
  test('cues become timed segments, speaker prefix is recognised, multi-line cues join', () => {
    const r = parseTranscript(srt, 'srt');
    expect(r.transcript.segments).toHaveLength(3);
    expect(r.transcript.segments[0]).toMatchObject({ startMs: 1000, endMs: 4500, speakerId: 'S1', text: 'Dobrý den všem.' });
    expect(r.transcript.segments[1].text).toBe('Začneme releasem. Máme dvě témata.');
    expect(r.transcript.segments[2]).toMatchObject({ startMs: 60250, endMs: 62000, speakerId: null });
    expect(r.warnings).toEqual([]);
  });
  test('invalid SRT (no cue timing) is refused', () => {
    fails(() => parseTranscript('Tohle není titulkový soubor.\nJen text.', 'srt'), 'invalid_srt');
  });
  test('cues with unparseable or reversed times are skipped; if none remain it is invalid', () => {
    fails(() => parseTranscript('1\n00:00:09,000 --> 00:00:01,000\nText\n', 'srt'), 'invalid_srt');
    fails(() => parseTranscript('1\nabc --> def\nText\n', 'srt'), 'invalid_srt');
    const r = parseTranscript('1\nabc --> def\nŠpatné\n\n2\n00:00:01,000 --> 00:00:02,000\nDobré\n', 'srt');
    expect(r.transcript.segments.map((s) => s.text)).toEqual(['Dobré']);
  });
  test('cues with empty text are skipped', () => {
    const r = parseTranscript('1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\nOK\n', 'srt');
    expect(r.transcript.segments).toHaveLength(1);
  });
});

describe('VTT', () => {
  test('requires the WEBVTT header', () => {
    fails(() => parseTranscript('00:00:01.000 --> 00:00:02.000\nText', 'vtt'), 'invalid_vtt');
  });
  test('voice tags and dotted milliseconds', () => {
    const r = parseTranscript('WEBVTT\n\n00:01.500 --> 00:03.000\n<v Petr Novák>Ahoj <i>všem</i>\n', 'vtt');
    expect(r.transcript.segments[0]).toMatchObject({ startMs: 1500, endMs: 3000, text: 'Ahoj všem' });
    expect(r.transcript.speakers[0].label).toBe('Petr Novák');
  });
});

describe('transcriptRevision', () => {
  test('is a stable sha256 hex of the content', async () => {
    const a = parseTranscript('Petr: Ahoj.', 'paste').transcript;
    const r1 = await transcriptRevision(a);
    expect(r1).toMatch(/^[0-9a-f]{64}$/);
    expect(await transcriptRevision(parseTranscript('Petr: Ahoj.', 'paste').transcript)).toBe(r1);
  });
  test('any content change changes the revision', async () => {
    const r1 = await transcriptRevision(parseTranscript('Petr: Ahoj.', 'paste').transcript);
    expect(await transcriptRevision(parseTranscript('Petr: Ahoj!', 'paste').transcript)).not.toBe(r1);
    expect(await transcriptRevision(parseTranscript('Jana: Ahoj.', 'paste').transcript)).not.toBe(r1);
  });
});
