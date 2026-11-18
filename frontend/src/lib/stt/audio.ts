/**
 * Validace nahrávky (R5). Čisté funkce, bezpečné v prohlížeči i na serveru: typ se pozná podle PŘÍPONY i podle
 * OBSAHU (magic bytes), takže soubor `.mp3`, který ve skutečnosti obsahuje text nebo spustitelný kód, projde jen
 * kontrolou přípony, ale ne touto. Rozhoduje obsah.
 */
export const MAX_AUDIO_BYTES = 52_428_800; // 50 MiB: strop Supabase Free i bucketu meeting-audio
export const MAX_AUDIO_MS = 18_000_000; // 300 minut: pevný limit jednoho souboru u Soniox
export const SNIFF_BYTES = 32;

export type AudioFormat = 'mp3' | 'm4a' | 'mp4' | 'wav' | 'webm' | 'ogg' | 'aac' | 'flac';

/** MIME, pod kterým se soubor ukládá do bucketu (musí být v jeho allow-listu). */
export const FORMAT_MIME: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

export const ACCEPT_ATTR = Object.keys(FORMAT_MIME).map((e) => `.${e}`).join(',');

/** Kontejnerové "rodiny": m4a/mp4 sdílejí ISO BMFF (ftyp), mp3 má ID3 nebo MPEG frame. */
type Family = 'mpeg' | 'iso' | 'wav' | 'webm' | 'ogg' | 'aac' | 'flac';
const FAMILY_OF: Record<AudioFormat, Family> = { mp3: 'mpeg', m4a: 'iso', mp4: 'iso', wav: 'wav', webm: 'webm', ogg: 'ogg', aac: 'aac', flac: 'flac' };

const ascii = (b: Uint8Array, from: number, len: number) => String.fromCharCode(...Array.from(b.slice(from, from + len)));

/** Rodina podle magic bytes, nebo null, když obsah není rozpoznaný zvukový formát. */
export function sniffAudioFamily(bytes: Uint8Array): Family | null {
  if (bytes.length < 4) return null;
  if (ascii(bytes, 0, 4) === 'RIFF' && bytes.length >= 12 && ascii(bytes, 8, 4) === 'WAVE') return 'wav';
  if (ascii(bytes, 0, 4) === 'OggS') return 'ogg';
  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') return 'iso';
  if (ascii(bytes, 0, 3) === 'ID3') return 'mpeg';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const layer = (bytes[1] >> 1) & 0x03; // 00 = ADTS (AAC), jinak MPEG audio
    return layer === 0 ? 'aac' : 'mpeg';
  }
  return null;
}

export function extensionOf(name: string): AudioFormat | null {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name.trim());
  const e = m?.[1].toLowerCase();
  return e && e in FORMAT_MIME ? (e as AudioFormat) : null;
}

export type AudioCheckCode = 'empty' | 'too_large' | 'unsupported_extension' | 'unrecognized' | 'content_mismatch';
export type AudioCheck = { ok: true; format: AudioFormat; mime: string } | { ok: false; code: AudioCheckCode; message: string };

export interface AudioMeta {
  name: string;
  size: number;
}

const MESSAGES: Record<AudioCheckCode, string> = {
  empty: 'Soubor je prázdný.',
  too_large: 'Soubor je větší než 50 MB. Zkraťte záznam nebo ho zkomprimujte (např. MP3 64 kbps ≈ 100 minut).',
  unsupported_extension: 'Nepodporovaný typ souboru. Použijte MP3, M4A, MP4, WAV, WebM, OGG, AAC nebo FLAC.',
  unrecognized: 'Obsah souboru není zvukový záznam.',
  content_mismatch: 'Obsah souboru neodpovídá jeho příponě.',
};

/** `head` = prvních `SNIFF_BYTES` bajtů souboru. Přípona i obsah se musí shodovat. */
export function validateAudio(meta: AudioMeta, head: Uint8Array): AudioCheck {
  const fail = (code: AudioCheckCode): AudioCheck => ({ ok: false, code, message: MESSAGES[code] });
  if (!Number.isFinite(meta.size) || meta.size <= 0) return fail('empty');
  if (meta.size > MAX_AUDIO_BYTES) return fail('too_large');
  const ext = extensionOf(meta.name);
  if (!ext) return fail('unsupported_extension');
  const family = sniffAudioFamily(head);
  if (!family) return fail('unrecognized');
  if (family !== FAMILY_OF[ext]) return fail('content_mismatch');
  return { ok: true, format: ext, mime: FORMAT_MIME[ext] };
}

/** Odhad délky pro REZERVACI rozpočtu: nikdy méně, než dovoluje velikost (i při 320 kbps), a nejvýše pevný limit. */
export function estimateAudioMs(clientMs: number | null | undefined, bytes: number): number {
  const fromSize = Math.floor((bytes * 8) / 320); // ms při 320 kbps = nejkratší možná délka
  const claimed = Number.isFinite(clientMs ?? NaN) ? Math.max(0, Math.floor(clientMs as number)) : 0;
  return Math.min(MAX_AUDIO_MS, Math.max(1, claimed, fromSize));
}

/** Odhad ceny (USD): přibližně 0,10 USD za hodinu zvuku (ověřeno 2026-11-18, diarizace a identifikace jazyka v ceně). */
export const SONIOX_USD_PER_HOUR = 0.1;
export function estimateSttCostUsd(audioMs: number): number {
  return Math.round((audioMs / 3_600_000) * SONIOX_USD_PER_HOUR * 10_000) / 10_000;
}
