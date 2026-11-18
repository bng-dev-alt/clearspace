import { fold } from './fold';
import type { Transcript, TranscriptSegment, TranscriptSpeaker } from './types';

/**
 * Parsování textových přepisů (MVP, ARCHITECTURE §8.1): vložený text, TXT, MD, SRT, VTT -> Transcript
 * (tvar podle UMC umc.transcript 1.0). Čistá logika bez IO, běží v prohlížeči i na serveru.
 *  - Nikdy nevymýšlí časy: bez časové značky ve zdroji je startMs/endMs = null.
 *  - Jména mluvčích bere jen ze zdroje ("Petr: ..." / <v Petr>), nikdy je neodhaduje.
 */

export const MAX_TRANSCRIPT_CHARS = 400_000;
export const MAX_SEGMENTS = 20_000;
const SPLIT_OVER = 1200; // delší odstavec se dělí na věty, aby byl důkaz přesný
const CHUNK_TARGET = 800;

export type TranscriptSource = 'paste' | 'txt' | 'md' | 'srt' | 'vtt';
export type TranscriptErrorCode =
  | 'empty'
  | 'too_long'
  | 'too_many_segments'
  | 'unsupported'
  | 'invalid_srt'
  | 'invalid_vtt';

export class TranscriptParseError extends Error {
  readonly code: TranscriptErrorCode;
  constructor(code: TranscriptErrorCode, message: string) {
    super(message);
    this.name = 'TranscriptParseError';
    this.code = code;
  }
}

export interface ParsedTranscript {
  transcript: Transcript;
  source: TranscriptSource;
  charCount: number;
  warnings: string[];
}

const EXT: Record<string, TranscriptSource> = {
  txt: 'txt',
  md: 'md',
  markdown: 'md',
  srt: 'srt',
  vtt: 'vtt',
};

/** Typ zdroje podle přípony; null = nepodporovaný soubor. */
export function sourceFromFilename(name: string): TranscriptSource | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return name.includes('.') ? (EXT[ext] ?? null) : null;
}

function normalize(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

// "00:12", "1:02:03", "00:00:01,500", "00:00:01.500" -> ms
function timeToMs(raw: string): number | null {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1] ?? 0), mi = Number(m[2]), s = Number(m[3]);
  if (mi > 59 && m[1] !== undefined) return null;
  if (s > 59) return null;
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return ((h * 60 + mi) * 60 + s) * 1000 + frac;
}

// Jméno mluvčího: začíná velkým písmenem, max 4 slova, jen písmena a . ' ’ -
const LABEL = String.raw`\p{Lu}[\p{L}.'’-]*(?:\s+[\p{L}][\p{L}.'’-]*){0,3}`;
const TS = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;
const LINE = new RegExp(String.raw`^(?:\[?(${TS})\]?\s+)?(?:(${LABEL}):\s+)?(.+)$`, 'u');

interface RawSeg {
  label: string | null;
  text: string;
  startMs: number | null;
  endMs?: number | null;
}

/** Rozdělí příliš dlouhý text na věty (cca 800 znaků), aby citace odkazovala na přesnější místo. */
function splitLong(text: string): string[] {
  if (text.length <= SPLIT_OVER) return [text];
  const sentences = text.match(/[^.!?…]+[.!?…]+["”')\]]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > CHUNK_TARGET) {
      out.push(cur.trim());
      cur = '';
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  // věta bez interpunkce delší než limit: tvrdý řez po slovech
  return out.flatMap((c) => {
    if (c.length <= SPLIT_OVER) return [c];
    const words = c.split(/\s+/);
    const parts: string[] = [];
    let w = '';
    for (const word of words) {
      if (w && w.length + word.length + 1 > CHUNK_TARGET) {
        parts.push(w);
        w = '';
      }
      w = w ? `${w} ${word}` : word;
    }
    if (w) parts.push(w);
    return parts;
  });
}

function stripMarkdown(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1');
}

function parseSpoken(text: string, md: boolean): RawSeg[] {
  const segs: RawSeg[] = [];
  let open = false; // je rozpracovaný segment, ke kterému se může lepit navazující řádek?
  for (const rawLine of text.split('\n')) {
    const line = (md ? stripMarkdown(rawLine) : rawLine).trim();
    if (!line) {
      open = false;
      continue;
    }
    const m = LINE.exec(line);
    const ts = m?.[1] ?? null;
    const label = m?.[2] ?? null;
    const body = (m?.[3] ?? line).trim();
    if (label || ts || !open || segs.length === 0) {
      segs.push({ label, text: body, startMs: ts ? timeToMs(ts) : null });
      open = true;
    } else {
      // navazující řádek téhož odstavce
      segs[segs.length - 1].text += ` ${body}`;
    }
  }
  // konec segmentu = začátek dalšího segmentu s časem (jinak null)
  for (let i = 0; i < segs.length; i++) {
    const next = segs.slice(i + 1).find((s) => s.startMs !== null);
    segs[i].endMs = segs[i].startMs !== null && next ? next.startMs : null;
  }
  return segs;
}

function parseCues(text: string, kind: 'srt' | 'vtt'): RawSeg[] {
  const invalid = kind === 'srt' ? 'invalid_srt' : 'invalid_vtt';
  const lines = text.split('\n');
  if (kind === 'vtt' && !/^WEBVTT\b/.test((lines.find((l) => l.trim()) ?? '').trim())) {
    throw new TranscriptParseError('invalid_vtt', 'Soubor VTT musí začínat řádkem WEBVTT.');
  }
  const segs: RawSeg[] = [];
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const bl = block.split('\n').map((l) => l.trim());
    const ti = bl.findIndex((l) => l.includes('-->'));
    if (ti === -1) continue;
    const [a, b] = bl[ti].split('-->').map((x) => x.trim().split(/\s+/)[0]);
    const start = timeToMs(a ?? ''), end = timeToMs(b ?? '');
    if (start === null || end === null || end < start) continue;
    let body = bl.slice(ti + 1).join(' ').trim();
    let label: string | null = null;
    const v = /^<v(?:\.[^\s>]+)?\s+([^>]+)>/.exec(body);
    if (v) label = v[1].trim();
    body = body.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const lm = label ? null : new RegExp(String.raw`^(${LABEL}):\s+(.+)$`, 'u').exec(body);
    if (lm) {
      label = lm[1];
      body = lm[2].trim();
    }
    if (!body) continue;
    segs.push({ label, text: body, startMs: start, endMs: end });
  }
  if (segs.length === 0) {
    throw new TranscriptParseError(invalid, `Soubor neobsahuje žádný platný titulek (${kind.toUpperCase()}).`);
  }
  return segs;
}

export function parseTranscript(input: string, source: TranscriptSource): ParsedTranscript {
  if (typeof input !== 'string') throw new TranscriptParseError('unsupported', 'Neplatný vstup.');
  const text = normalize(input);
  if (!text.trim()) throw new TranscriptParseError('empty', 'Přepis je prázdný.');
  if (text.length > MAX_TRANSCRIPT_CHARS * 2) {
    throw new TranscriptParseError('too_long', 'Přepis je příliš dlouhý (max 400 000 znaků).');
  }

  const raw =
    source === 'srt' || source === 'vtt' ? parseCues(text, source) : parseSpoken(text, source === 'md');
  const warnings: string[] = [];

  const speakers: TranscriptSpeaker[] = [];
  const speakerIdByFold = new Map<string, string>();
  const segments: TranscriptSegment[] = [];
  for (const r of raw) {
    let speakerId: string | null = null;
    if (r.label) {
      const key = fold(r.label);
      let id = speakerIdByFold.get(key);
      if (!id) {
        id = `S${speakers.length + 1}`;
        speakerIdByFold.set(key, id);
        speakers.push({ id, label: r.label.trim(), displayName: null });
      }
      speakerId = id;
    }
    for (const chunk of splitLong(r.text)) {
      if (!chunk.trim()) continue;
      segments.push({
        id: `seg-${segments.length}`,
        startMs: r.startMs,
        endMs: r.endMs ?? null,
        speakerId,
        text: chunk.trim(),
      });
    }
  }
  if (segments.length === 0) throw new TranscriptParseError('empty', 'Přepis neobsahuje žádný text.');
  if (segments.length > MAX_SEGMENTS) {
    throw new TranscriptParseError('too_many_segments', 'Přepis má příliš mnoho segmentů.');
  }
  const charCount = segments.reduce((n, s) => n + s.text.length, 0);
  if (charCount > MAX_TRANSCRIPT_CHARS) {
    throw new TranscriptParseError('too_long', 'Přepis je příliš dlouhý (max 400 000 znaků).');
  }
  if (speakers.length === 0 && source !== 'srt' && source !== 'vtt') {
    warnings.push('V přepisu nebyla rozpoznána jména mluvčích (formát „Jméno: text"). Vlastníky úkolů bude možné určit jen z textu.');
  }
  if (segments.every((s) => s.startMs === null)) {
    warnings.push('Přepis neobsahuje časové značky; odkazy na důkazy ukazují jen na segment.');
  }
  return { transcript: { speakers, segments }, source, charCount, warnings };
}

/** sha256 (hex) kanonického obsahu přepisu = revize. Web Crypto je v prohlížeči i v Node 20+. */
export async function transcriptRevision(t: Transcript): Promise<string> {
  const canonical = JSON.stringify({
    speakers: t.speakers.map((s) => [s.id, s.label, s.displayName]),
    segments: t.segments.map((s) => [s.id, s.startMs, s.endMs, s.speakerId, s.text]),
  });
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
