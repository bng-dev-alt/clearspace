import type { Transcript, TranscriptSegment, TranscriptSpeaker } from '../intelligence/types';
import { MAX_TRANSCRIPT_CHARS, MAX_SEGMENTS, transcriptRevision } from '../intelligence/transcript';

/**
 * Normalizace výstupu Soniox async (`GET /v1/transcriptions/{id}/transcript`) na `Transcript` (R5).
 * Pravidla vychází z ověřené dokumentace (docs/intelligence/SONIOX_API_VERIFICATION.md) a z poučení scribe_:
 *  - tokeny jsou části slov a nesou vlastní úvodní mezeru: spojují se DOSLOVNĚ, mezery se nevkládají;
 *  - `speaker` je číselný řetězec ("1".."15") jen při diarizaci; mapuje se na S1..Sn;
 *  - časy jsou v ms; konec se ořízne tak, aby nebyl před začátkem;
 *  - značky <end>/<fin> v async výstupu dokumentované nejsou, filtr zůstává jako pojistka;
 *  - delší repliky se dělí na hranici věty, aby důkaz ukazoval na přesný úsek.
 */

export interface SonioxToken {
  text?: unknown;
  start_ms?: unknown;
  end_ms?: unknown;
  confidence?: unknown;
  speaker?: unknown;
  language?: unknown;
  is_audio_event?: unknown;
}

export const SPLIT_AFTER_MS = 30_000;
export const SPLIT_AFTER_CHARS = 600;
const HARD_SPLIT_CHARS = 1_200;
const GAP_MS = 2_000;
const GAP_CAP = 200;
const SENTENCE_END = /[.?!…]["')\]]*\s*$/;
const MARKERS = new Set(['<end>', '<fin>']);

export class NormalizeError extends Error {
  readonly code: 'empty' | 'too_long';
  constructor(code: 'empty' | 'too_long', message: string) {
    super(message);
    this.name = 'NormalizeError';
    this.code = code;
  }
}

export interface Coverage {
  durationMs: number;
  speechMs: number;
  tokenCount: number;
  gapCount: number;
  /** Úseky delší než 2 s bez tokenů (označeny, nedoplňují se). */
  gaps: { startMs: number; endMs: number }[];
}

export interface NormalizedTranscript {
  transcript: Transcript;
  coverage: Coverage;
  charCount: number;
  /** Délka zvuku podle posledního tokenu (záloha, kdyby Soniox `audio_duration_ms` nevrátil). */
  durationMs: number;
  revision: string;
}

interface Tok {
  text: string;
  start: number;
  end: number;
  speaker: string | null;
  language: string | null;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function toTokens(raw: unknown[]): Tok[] {
  const out: Tok[] = [];
  let lastEnd = 0;
  for (const t of raw) {
    if (typeof t !== 'object' || t === null) continue;
    const r = t as SonioxToken;
    if (typeof r.text !== 'string' || r.text === '' || r.is_audio_event === true) continue;
    // řídicí znaky pryč (zůstává mezera a tabulátor), značky pryč
    const text = r.text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
    if (!text || MARKERS.has(text.trim().toLowerCase())) continue;
    const start = isInt(r.start_ms) ? Math.floor(r.start_ms) : lastEnd;
    const end = Math.max(start, isInt(r.end_ms) ? Math.floor(r.end_ms) : start);
    lastEnd = end;
    out.push({
      text,
      start,
      end,
      speaker: typeof r.speaker === 'string' || typeof r.speaker === 'number' ? String(r.speaker) : null,
      language: typeof r.language === 'string' && r.language ? r.language.slice(0, 12) : null,
    });
  }
  return out;
}

export async function normalizeSonioxTokens(rawTokens: unknown): Promise<NormalizedTranscript> {
  const toks = toTokens(Array.isArray(rawTokens) ? rawTokens : []);
  if (toks.length === 0 || toks.every((t) => t.text.trim() === '')) {
    throw new NormalizeError('empty', 'Přepis neobsahuje žádnou řeč.');
  }

  // --- mluvčí v pořadí prvního výskytu ---
  const order: string[] = [];
  for (const t of toks) if (t.speaker !== null && !order.includes(t.speaker)) order.push(t.speaker);
  const used = new Set<string>();
  const idOf = new Map<string, string>();
  order.forEach((sp, i) => {
    let id = /^\d{1,2}$/.test(sp) ? `S${Number(sp)}` : `S${i + 1}`;
    while (used.has(id)) id = `${id}x`;
    used.add(id);
    idOf.set(sp, id);
  });
  const speakers: TranscriptSpeaker[] = order.map((sp, i) => ({
    id: idOf.get(sp) as string,
    label: `Mluvčí ${/^\d{1,2}$/.test(sp) ? Number(sp) : i + 1}`,
    displayName: null,
  }));

  // --- repliky: po sobě jdoucí tokeny stejného mluvčího, dělené na hranici věty ---
  const segments: TranscriptSegment[] = [];
  const idCount = new Map<string, number>();
  let cur: Tok[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const text = cur.map((t) => t.text).join('').replace(/\s+/g, ' ').trim();
    if (text) {
      const start = cur[0].start;
      const end = Math.max(start, cur[cur.length - 1].end);
      const base = `seg-${start}`;
      const n = idCount.get(base) ?? 0;
      idCount.set(base, n + 1);
      const langs = new Map<string, number>();
      for (const t of cur) if (t.language) langs.set(t.language, (langs.get(t.language) ?? 0) + t.text.trim().length);
      const lang = [...langs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const sp = cur[0].speaker;
      segments.push({
        id: `${base}-${n}`,
        startMs: start,
        endMs: end,
        speakerId: sp !== null ? (idOf.get(sp) ?? null) : null,
        text,
        ...(lang ? { language: lang } : {}),
      });
    }
    cur = [];
  };
  let curChars = 0;
  for (const t of toks) {
    if (cur.length > 0 && cur[0].speaker !== t.speaker) {
      flush();
      curChars = 0;
    }
    cur.push(t);
    curChars += t.text.length;
    const lastTok = cur[cur.length - 1];
    const dur = lastTok.end - cur[0].start;
    const tooLong = dur >= SPLIT_AFTER_MS || curChars >= SPLIT_AFTER_CHARS;
    if ((tooLong && SENTENCE_END.test(t.text)) || curChars >= HARD_SPLIT_CHARS) {
      flush();
      curChars = 0;
    }
  }
  flush();

  if (segments.length === 0) throw new NormalizeError('empty', 'Přepis neobsahuje žádnou řeč.');
  if (segments.length > MAX_SEGMENTS) throw new NormalizeError('too_long', 'Přepis má příliš mnoho segmentů.');
  const charCount = segments.reduce((n, s) => n + s.text.length, 0);
  if (charCount > MAX_TRANSCRIPT_CHARS) throw new NormalizeError('too_long', 'Přepis je příliš dlouhý (max 400 000 znaků).');

  // --- pokrytí: mezery delší než 2 s se označí, nedoplňují se ---
  const gaps: Coverage['gaps'] = [];
  let gapCount = 0;
  let speechMs = 0;
  let prevEnd = toks[0].start;
  for (const t of toks) {
    if (t.start - prevEnd > GAP_MS) {
      gapCount += 1;
      if (gaps.length < GAP_CAP) gaps.push({ startMs: prevEnd, endMs: t.start });
    }
    speechMs += Math.max(0, t.end - t.start);
    prevEnd = Math.max(prevEnd, t.end);
  }
  const durationMs = Math.max(...toks.map((t) => t.end));

  const transcript: Transcript = { speakers, segments };
  return {
    transcript,
    coverage: { durationMs, speechMs, tokenCount: toks.length, gapCount, gaps },
    charCount,
    durationMs,
    revision: await transcriptRevision(transcript),
  };
}
