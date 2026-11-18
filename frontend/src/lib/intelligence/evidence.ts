import { fold, foldedWords, letterCount } from './fold';
import { aliasInWords } from './names';
import type { Evidence, SourceRecord, Support, Transcript, TranscriptSegment } from './types';

/**
 * Deterministický validátor výstupu modelu (ARCHITECTURE §7.2, §8.3). Je to hranice důvěry:
 * model nikdy nenastavuje `support`, časy, ani to, zda je vlastník nebo termín podložený.
 * Port scribe_ BriefValidator + MicroCRM groundedOwner, podle UMC `umc-validator-1`.
 */

export const VALIDATOR_VERSION = 'cs-evidence-v2';

export const MIN_QUOTE_LETTERS = 6;
/** v2: jedno slovo není důkaz (ani dlouhé, např. "migrace"): citace musí mít aspoň 2 slova. */
export const MIN_QUOTE_WORDS = 2;
export const MAX_QUOTE_CHARS = 200;
export const MAX_ITEM_TEXT = 800;
const MAX_PER_SECTION = 40;
const MAX_EVIDENCE = 4;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'unparseable' | 'empty_summary'; message: string };

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clipStr = (v: unknown, max: number): string => {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > max ? t.slice(0, max) : t;
};

/** Citace musí mít aspoň 6 písmen a každá její část (dělení na „…") musí být (složená) obsažena v textu zdroje. */
export function quoteSupported(quote: string, sourceText: string): boolean {
  const parts = quote
    .split(/…|\.\.\./)
    .map((p) => fold(p))
    .filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  const joined = parts.join(' ');
  if (letterCount(joined) < MIN_QUOTE_LETTERS || joined.split(' ').length < MIN_QUOTE_WORDS) return false;
  const hay = fold(sourceText);
  return parts.every((p) => hay.includes(p));
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Český ohebný tvar (Honza/Honzovi, Petr/Petrovi): token a slovo musí sdílet prefix délky ≥ max(3, kratší−1).
 * Kratší z dvojice musí mít aspoň 3 písmena a třípísmenné slovo se hodí jen k tvarům do 4 písmen
 * (Jan/Jana), aby předložka „pro" nepodložila jméno „Prokop".
 */
export function tokenInWords(token: string, words: string[]): boolean {
  return words.some((w) => {
    const short = Math.min(token.length, w.length);
    const long = Math.max(token.length, w.length);
    if (short < 3 || (short === 3 && long > 4)) return false;
    return commonPrefix(token, w) >= Math.max(3, short - 1);
  });
}

const NOT_A_NAME = new Set([
  'ja', 'i', 'me', 'my', 'we', 'us', 'myself', 'unknown', 'neznamy', 'nikdo', 'someone', 'nobody',
  'team', 'tym', 'vsichni', 'everyone', 'client', 'klient', 'none', 'null', 'n a',
]);

const GENERIC_SPEAKER = /^(speaker|mluvci|spk|s|participant|ucastnik)( \d+)?$/;

/** Jméno mluvčího jen pokud je to skutečné jméno (ne „Mluvčí 1" / „Speaker 2"). */
export function realSpeakerName(seg: TranscriptSegment, transcript: Transcript): string | null {
  if (!seg.speakerId) return null;
  const sp = transcript.speakers.find((s) => s.id === seg.speakerId);
  if (!sp) return null;
  const name = (sp.displayName ?? sp.label).trim();
  const f = fold(name);
  return f && !GENERIC_SPEAKER.test(f) ? name : null;
}

/** Vlastník smí být jen jméno, které je doslova v citovaném textu (nebo je to skutečné jméno mluvčího). */
export function groundedOwner(owner: string | null, cited: TranscriptSegment[], transcript: Transcript): string | null {
  if (!owner) return null;
  const clipped = clipStr(owner, 100);
  const f = fold(clipped);
  if (!f || NOT_A_NAME.has(f) || /^(speaker|mluvci)/.test(f)) return null;
  const words = [
    ...cited.flatMap((s) => foldedWords(s.text)),
    ...cited.flatMap((s) => foldedWords(realSpeakerName(s, transcript) ?? '')),
  ];
  // v2: domácké tvary (Honza = Jan) a skloňování (Honzovi) se berou jako stejné jméno
  return f.split(' ').every((t) => tokenInWords(t, words) || aliasInWords(t, words)) ? clipped : null;
}

// ------------------------------------------------------------------ Meeting brief

export type MeetingItemKind = 'decision' | 'action_item' | 'follow_up' | 'risk' | 'blocker' | 'open_question';
export type Confidence = 'high' | 'medium' | 'low';

export interface ValidatedMeetingItem {
  kind: MeetingItemKind;
  text: string;
  support: Support;
  evidence: Evidence[];
  confidence: Confidence | null;
  ownerText: string | null;
  dueText: string | null;
  existingCardId: string | null;
}

export interface ValidatedChapter {
  title: string;
  firstSegment: string;
  lastSegment: string;
}

export interface ValidatedMeetingBrief {
  summary: string;
  items: ValidatedMeetingItem[];
  chapters: ValidatedChapter[];
  /** Položky zahozené validátorem (bez důkazu, přes limit). */
  rejectedCount: number;
  /** Pole vynulovaná validátorem (nepodložený vlastník / termín / existing_card_id). */
  nulledFields: number;
}

const SECTIONS: [string, MeetingItemKind][] = [
  ['decisions', 'decision'],
  ['action_items', 'action_item'],
  ['follow_ups', 'follow_up'],
  ['risks', 'risk'],
  ['blockers', 'blocker'],
  ['open_questions', 'open_question'],
];
const MUST_BE_LINKED: MeetingItemKind[] = ['decision', 'action_item'];

export function validateMeetingBrief(
  raw: unknown,
  transcript: Transcript,
  opts: { activeCardIds?: Iterable<string> } = {}
): ValidationResult<ValidatedMeetingBrief> {
  if (!isObj(raw)) return { ok: false, code: 'unparseable', message: 'Výstup modelu není objekt.' };
  const summary = clipStr(raw.summary, 2000);
  if (!summary) return { ok: false, code: 'empty_summary', message: 'Model nevrátil shrnutí.' };

  const segById = new Map(transcript.segments.map((s) => [s.id, s]));
  const segIndex = new Map(transcript.segments.map((s, i) => [s.id, i]));
  const seenItems = new Set<string>();
  const activeCards = new Set(opts.activeCardIds ?? []);
  const items: ValidatedMeetingItem[] = [];
  let rejected = 0;
  let nulled = 0;

  for (const [key, kind] of SECTIONS) {
    const list = arr(raw[key]);
    let kept = 0;
    for (const rawItem of list) {
      if (!isObj(rawItem)) {
        rejected += 1;
        continue;
      }
      if (kept >= MAX_PER_SECTION) {
        rejected += 1;
        continue;
      }
      const text = clipStr(rawItem.text, MAX_ITEM_TEXT);
      const evidence: Evidence[] = [];
      const cited: TranscriptSegment[] = [];
      const seenEvidence = new Set<string>();
      for (const e of arr(rawItem.evidence).slice(0, MAX_EVIDENCE)) {
        if (!isObj(e) || typeof e.segment_id !== 'string') continue;
        const seg = segById.get(e.segment_id);
        if (!seg) continue; // vymyšlený segment
        const quote = typeof e.quote === 'string' && e.quote.trim() ? clipStr(e.quote, MAX_QUOTE_CHARS) : null;
        // v2: stejná dvojice segment + citace se nepočítá dvakrát
        const dupKey = `${seg.id}|${quote ? fold(quote) : ''}`;
        if (seenEvidence.has(dupKey)) continue;
        seenEvidence.add(dupKey);
        // v2: citace, která přesahuje z citovaného segmentu do sousedního (věta rozdělená na dva řádky přepisu)
        const i = segIndex.get(seg.id) ?? -1;
        const next = i >= 0 ? transcript.segments[i + 1] : undefined;
        const found = quote !== null && (quoteSupported(quote, seg.text) || (next !== undefined && quoteSupported(quote, `${seg.text} ${next.text}`)));
        evidence.push({
          ref: `segment:${seg.id}`,
          quote,
          quoteFound: found,
          startMs: seg.startMs,
          endMs: seg.endMs,
        });
        cited.push(seg);
      }
      if (!text || evidence.length === 0) {
        rejected += 1;
        continue;
      }
      const support: Support = evidence.some((e) => e.quoteFound) ? 'linked' : 'unverified';
      if (MUST_BE_LINKED.includes(kind) && support !== 'linked') {
        rejected += 1;
        continue;
      }

      // v2: model, který opakuje stejnou položku (stejný druh a složený text), ji nezdvojí
      const itemKey = `${kind}:${fold(text)}`;
      if (seenItems.has(itemKey)) {
        rejected += 1;
        continue;
      }
      seenItems.add(itemKey);

      let ownerText: string | null = null;
      let dueText: string | null = null;
      let existingCardId: string | null = null;
      if (kind === 'action_item') {
        const o = typeof rawItem.owner_text === 'string' && rawItem.owner_text.trim() ? rawItem.owner_text : null;
        ownerText = groundedOwner(o, cited, transcript);
        if (o && !ownerText) nulled += 1;
        const d = clipStr(rawItem.due_text, 100);
        if (d) {
          const hay = fold(cited.map((s) => s.text).join(' '));
          const fd = fold(d);
          if (fd && hay.includes(fd)) dueText = d;
          else nulled += 1;
        }
        // Model smí vrátit i celý ref z kontextu ("card:ID"); porovnává se holé id karty.
        const c = typeof rawItem.existing_card_id === 'string' ? rawItem.existing_card_id.replace(/^card:/, '') : null;
        if (c) {
          if (activeCards.has(c)) existingCardId = c;
          else nulled += 1;
        }
      }
      const conf = rawItem.confidence;
      items.push({
        kind,
        text,
        support,
        evidence,
        confidence: conf === 'high' || conf === 'medium' || conf === 'low' ? conf : null,
        ownerText,
        dueText,
        existingCardId,
      });
      kept += 1;
    }
  }

  // Kapitoly: vzestupné, nepřekrývající se, jen existující segmenty.
  const idx = new Map(transcript.segments.map((s, i) => [s.id, i]));
  const chapters: ValidatedChapter[] = [];
  let prevLast = -1;
  for (const c of arr(raw.chapters)) {
    if (!isObj(c) || chapters.length >= MAX_PER_SECTION) continue;
    const a = typeof c.first_segment === 'string' ? idx.get(c.first_segment) : undefined;
    const b = typeof c.last_segment === 'string' ? idx.get(c.last_segment) : undefined;
    const title = clipStr(c.title, 200);
    if (a === undefined || b === undefined || !title || a > b || a <= prevLast) continue;
    chapters.push({ title, firstSegment: c.first_segment as string, lastSegment: c.last_segment as string });
    prevLast = b;
  }

  return { ok: true, value: { summary, items, chapters, rejectedCount: rejected, nulledFields: nulled } };
}

// ------------------------------------------------------------------ Project brief

export type BriefActionKind = 'create' | 'update' | 'unblock' | 'assign' | 'clarify';
export type Severity = 'low' | 'medium' | 'high';

export interface BriefItem {
  text: string;
  severity: Severity | null;
  support: Support;
  evidence: Evidence[];
}
export interface BriefAction {
  text: string;
  kind: BriefActionKind;
  targetCardId: string | null;
  support: Support;
  evidence: Evidence[];
}
export interface ValidatedProjectBrief {
  summary: string;
  healthNarrative: string;
  risks: BriefItem[];
  blockers: BriefItem[];
  nextActions: BriefAction[];
  openQuestions: BriefItem[];
  notesOnData: string[];
  rejectedCount: number;
}

const CAPS = { risks: 8, blockers: 8, next_actions: 5, open_questions: 8, notes: 3 };
const ACTION_KINDS: BriefActionKind[] = ['create', 'update', 'unblock', 'assign', 'clarify'];

/** Datumy ve tvaru YYYY-MM-DD nebo d.m.yyyy v textu tvrzení -> YYYY-MM-DD. */
function datesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(/\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\b/g))
    out.push(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  return out;
}

export function validateProjectBrief(
  raw: unknown,
  sources: SourceRecord[],
  opts: { activeCardIds?: Iterable<string> } = {}
): ValidationResult<ValidatedProjectBrief> {
  if (!isObj(raw)) return { ok: false, code: 'unparseable', message: 'Výstup modelu není objekt.' };
  const summary = clipStr(raw.summary, 1200);
  if (!summary) return { ok: false, code: 'empty_summary', message: 'Model nevrátil shrnutí.' };

  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const activeCards = new Set(opts.activeCardIds ?? []);
  let rejected = 0;

  /** Společná kontrola: refs musí existovat, citace musí sedět, data musí být podložená. */
  const ground = (r: Raw): { support: Support; evidence: Evidence[] } | null => {
    const refs = [...new Set(arr(r.refs).filter((x): x is string => typeof x === 'string'))]
      .filter((x) => byRef.has(x))
      .slice(0, MAX_EVIDENCE);
    if (refs.length === 0) return null;
    const quote = typeof r.quote === 'string' && r.quote.trim() ? clipStr(r.quote, MAX_QUOTE_CHARS) : null;
    const hit = quote ? refs.find((x) => quoteSupported(quote, byRef.get(x)!.text)) : undefined;
    const evidence: Evidence[] = refs.map((ref) => ({ ref, quote: ref === hit ? quote : null, quoteFound: ref === hit }));
    let support: Support = quote && !hit ? 'unverified' : 'linked';
    // Datum v textu tvrzení musí být v citovaných zdrojích (text nebo metadata), jinak neověřeno.
    const text = clipStr(r.text, MAX_ITEM_TEXT);
    const hay = fold(refs.map((x) => `${byRef.get(x)!.text} ${JSON.stringify(byRef.get(x)!.meta ?? {})}`).join(' '));
    for (const d of datesIn(text)) if (!hay.includes(fold(d))) support = 'unverified';
    return { support, evidence };
  };

  const items = (key: 'risks' | 'blockers' | 'open_questions', cap: number): BriefItem[] => {
    const out: BriefItem[] = [];
    for (const r of arr(raw[key])) {
      if (!isObj(r) || out.length >= cap) {
        rejected += 1;
        continue;
      }
      const text = clipStr(r.text, MAX_ITEM_TEXT);
      const g = text ? ground(r) : null;
      if (!g) {
        rejected += 1;
        continue;
      }
      const sev = r.severity;
      out.push({ text, severity: sev === 'low' || sev === 'medium' || sev === 'high' ? sev : null, ...g });
    }
    return out;
  };

  const nextActions: BriefAction[] = [];
  for (const r of arr(raw.next_actions)) {
    if (!isObj(r) || nextActions.length >= CAPS.next_actions) {
      rejected += 1;
      continue;
    }
    const text = clipStr(r.text, MAX_ITEM_TEXT);
    const g = text ? ground(r) : null;
    if (!g) {
      rejected += 1;
      continue;
    }
    const target = typeof r.target_card_id === 'string' && activeCards.has(r.target_card_id) ? r.target_card_id : null;
    const kind = ACTION_KINDS.includes(r.kind as BriefActionKind) ? (r.kind as BriefActionKind) : 'clarify';
    nextActions.push({ text, kind, targetCardId: target, ...g });
  }

  return {
    ok: true,
    value: {
      summary,
      healthNarrative: clipStr(raw.health_narrative, 600),
      risks: items('risks', CAPS.risks),
      blockers: items('blockers', CAPS.blockers),
      nextActions,
      openQuestions: items('open_questions', CAPS.open_questions),
      notesOnData: arr(raw.notes_on_data).map((n) => clipStr(n, 300)).filter(Boolean).slice(0, CAPS.notes),
      rejectedCount: rejected,
    },
  };
}
