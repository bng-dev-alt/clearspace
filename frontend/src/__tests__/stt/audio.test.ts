import { describe, test, expect } from 'vitest';
import { estimateAudioMs, estimateSttCostUsd, extensionOf, MAX_AUDIO_BYTES, MAX_AUDIO_MS, sniffAudioFamily, validateAudio } from '../../lib/stt/audio';

const bytes = (...b: number[]) => Uint8Array.from([...b, ...new Array(32).fill(0)].slice(0, 32));
const ascii = (s: string, at = 0) => { const a = new Array(32).fill(0); for (let i = 0; i < s.length; i++) a[at + i] = s.charCodeAt(i); return Uint8Array.from(a); };

const HEAD = {
  wav: (() => { const a = ascii('RIFF'); a.set([0x57, 0x41, 0x56, 0x45], 8); return a; })(),
  mp3Id3: ascii('ID3'),
  mp3Frame: bytes(0xff, 0xfb, 0x90),
  aacAdts: bytes(0xff, 0xf1, 0x50),
  m4a: ascii('ftypM4A ', 4),
  mp4: ascii('ftypisom', 4),
  ogg: ascii('OggS'),
  flac: ascii('fLaC'),
  webm: bytes(0x1a, 0x45, 0xdf, 0xa3),
};

describe('sniffAudioFamily: content decides, not the file name', () => {
  test.each([
    ['wav', HEAD.wav, 'wav'], ['mp3 (ID3)', HEAD.mp3Id3, 'mpeg'], ['mp3 (frame sync)', HEAD.mp3Frame, 'mpeg'], ['aac (ADTS)', HEAD.aacAdts, 'aac'],
    ['m4a', HEAD.m4a, 'iso'], ['mp4', HEAD.mp4, 'iso'], ['ogg', HEAD.ogg, 'ogg'], ['flac', HEAD.flac, 'flac'], ['webm', HEAD.webm, 'webm'],
  ])('%s', (_n, head, fam) => expect(sniffAudioFamily(head as Uint8Array)).toBe(fam));
  test.each([
    ['plain text', ascii('Ahoj, tohle je text.')], ['HTML', ascii('<!DOCTYPE html>')], ['Windows executable', ascii('MZ')], ['PDF', ascii('%PDF-1.7')],
    ['PNG', bytes(0x89, 0x50, 0x4e, 0x47)], ['empty', new Uint8Array(0)], ['3 bytes', Uint8Array.from([1, 2, 3])], ['RIFF but not WAVE (AVI)', (() => { const a = ascii('RIFF'); a.set([0x41, 0x56, 0x49, 0x20], 8); return a; })()],
  ])('%s is not audio', (_n, head) => expect(sniffAudioFamily(head as Uint8Array)).toBeNull());
});

describe('validateAudio', () => {
  test('accepts a matching name and content and returns the MIME the bucket allows', () => {
    expect(validateAudio({ name: 'porada.mp3', size: 1000 }, HEAD.mp3Id3)).toEqual({ ok: true, format: 'mp3', mime: 'audio/mpeg' });
    expect(validateAudio({ name: 'Porada.M4A', size: 1000 }, HEAD.m4a)).toMatchObject({ ok: true, format: 'm4a', mime: 'audio/mp4' });
    expect(validateAudio({ name: 'x.wav', size: 1000 }, HEAD.wav)).toMatchObject({ ok: true, mime: 'audio/wav' });
  });
  test.each([
    ['empty file', { name: 'a.mp3', size: 0 }, HEAD.mp3Id3, 'empty'],
    ['over 50 MB', { name: 'a.mp3', size: MAX_AUDIO_BYTES + 1 }, HEAD.mp3Id3, 'too_large'],
    ['exactly 50 MB is allowed', { name: 'a.mp3', size: MAX_AUDIO_BYTES }, HEAD.mp3Id3, null],
    ['unsupported extension', { name: 'a.pdf', size: 10 }, HEAD.mp3Id3, 'unsupported_extension'],
    ['no extension', { name: 'recording', size: 10 }, HEAD.mp3Id3, 'unsupported_extension'],
    ['text renamed to .mp3', { name: 'a.mp3', size: 10 }, ascii('just text'), 'unrecognized'],
    ['executable renamed to .wav', { name: 'a.wav', size: 10 }, ascii('MZ'), 'unrecognized'],
    ['a real WAV named .mp3', { name: 'a.mp3', size: 10 }, HEAD.wav, 'content_mismatch'],
    ['an OGG named .flac', { name: 'a.flac', size: 10 }, HEAD.ogg, 'content_mismatch'],
    ['NaN size', { name: 'a.mp3', size: NaN }, HEAD.mp3Id3, 'empty'],
  ])('%s', (_n, meta, head, code) => {
    const r = validateAudio(meta, head as Uint8Array);
    if (code === null) expect(r.ok).toBe(true);
    else expect(r).toMatchObject({ ok: false, code });
  });
  test('every refusal has a readable Czech message', () => {
    const r = validateAudio({ name: 'a.mp3', size: 10 }, ascii('x'));
    expect(r.ok === false && r.message.length).toBeGreaterThan(10);
  });
  test('extensionOf', () => {
    expect(extensionOf('a.b.MP3')).toBe('mp3');
    expect(extensionOf('a.exe')).toBeNull();
    expect(extensionOf('mp3')).toBeNull();
  });
});

describe('estimates', () => {
  test('a lying client cannot under-reserve: the estimate is never below what the file size allows (320 kbps)', () => {
    expect(estimateAudioMs(1000, 50_000_000)).toBe(Math.floor((50_000_000 * 8) / 320));
    expect(estimateAudioMs(null, 1_000_000)).toBe(25_000);
  });
  test('a longer claimed duration wins, and the fixed 300-minute cap applies', () => {
    expect(estimateAudioMs(600_000, 1_000_000)).toBe(600_000);
    expect(estimateAudioMs(99_999_999, 1_000_000)).toBe(MAX_AUDIO_MS);
    expect(estimateAudioMs(NaN, 0)).toBe(1);
  });
  test('cost estimate is $0.10 per audio hour', () => {
    expect(estimateSttCostUsd(3_600_000)).toBe(0.1);
    expect(estimateSttCostUsd(1_800_000)).toBe(0.05);
    expect(estimateSttCostUsd(0)).toBe(0);
  });
});
