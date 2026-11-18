import { fold, foldedWords, letterCount } from './fold';
import { aliasInWords } from './names';
import type { BriefSupport, Evidence, SourceRecord, Support, Transcript, TranscriptSegment } from './types';

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

// ------------------------------------------------------------------ Tokenizace a hledání citace

interface Tok {
  /** Složené (FOLD_SPEC) slovo. */
  w: string;
  /** Offsety slova v původním textu. */
  s: number;
  e: number;
}

/**
 * Slova původního textu s offsety. Shoduje se s `foldedWords` (stejné dělení na písmena/číslice), ale pamatuje si pozice,
 * aby šlo poznat hranice vět a klauzí (fold interpunkci zahazuje).
 */
function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const f = fold(m[0]);
    if (!f) continue;
    for (const w of f.split(' ')) out.push({ w, s: m.index, e: m.index + m[0].length });
  }
  return out;
}

/** Hranice věty/klauze mezi dvěma slovy: . ! ? ; … : (jmenovka mluvčího), nový řádek. Tečka v "2.0" hranice není. */
const BOUNDARY_INNER = /[!?;…\n\r]|[.:]\s/;
const BOUNDARY_EDGE = /[!?;…\n\r]|[.:](?:\s|$)/;

interface Analysed {
  toks: Tok[];
  words: string[];
  /** brk[k]: mezi slovem k-1 a k je hranice (k = 0 a k = n jsou okraje textu). */
  brk: boolean[];
  /** qm[k]: mezera před slovem k obsahuje otazník. */
  qm: boolean[];
}

function analyse(text: string): Analysed {
  const toks = tokenize(text);
  const n = toks.length;
  const brk: boolean[] = [];
  const qm: boolean[] = [];
  for (let k = 0; k <= n; k += 1) {
    const gap = text.slice(k === 0 ? 0 : toks[k - 1].e, k === n ? text.length : toks[k].s);
    brk.push((k === 0 || k === n ? BOUNDARY_EDGE : BOUNDARY_INNER).test(gap));
    qm.push(gap.includes('?'));
  }
  return { toks, words: toks.map((t) => t.w), brk, qm };
}

export const MAX_ELLIPSIS_GAP_WORDS = 12;
/** Každá část citace oddělená "…" musí mít aspoň 2 slova nebo 8 písmen ("jsme … jsme" tedy není důkaz). */
const MIN_PART_WORDS = 2;
const MIN_PART_LETTERS = 8;

/** Části citace (dělení na "…" / "...") jako složená slova; bez kontroly minimální délky. */
function rawParts(quote: string): string[][] {
  return quote
    .split(/…|\.\.\./)
    .map(foldedWords)
    .filter((p) => p.length > 0);
}

/** Části citace, jen pokud splňují pravidla délky; jinak null. */
function quoteParts(quote: string): string[][] | null {
  const parts = rawParts(quote);
  if (parts.length === 0) return null;
  const all = parts.flat();
  if (letterCount(all.join(' ')) < MIN_QUOTE_LETTERS || all.length < MIN_QUOTE_WORDS) return null;
  if (parts.some((p) => p.length < MIN_PART_WORDS && letterCount(p.join(' ')) < MIN_PART_LETTERS)) return null;
  if (new Set(parts.map((p) => p.join(' '))).size !== parts.length) return null; // stejná část dvakrát = trik se vzdáleným slovem
  return parts;
}

interface Occurrence {
  /** První a poslední slovo výskytu (včetně) v tokenech zdroje. */
  a: number;
  b: number;
  /** V mezeře mezi částmi ("…") je zápor: citace by tvrdila opak toho, co je ve zdroji. */
  gapNeg: boolean;
}

/** Všechny výskyty citace: části za sebou, mezera mezi nimi nejvýš MAX_ELLIPSIS_GAP_WORDS slov. */
function findOccurrences(parts: string[][], words: string[]): Occurrence[] {
  const at = (p: string[], i: number) => p.every((w, k) => words[i + k] === w);
  const out: Occurrence[] = [];
  for (let i = 0; i < words.length; i += 1) {
    if (!at(parts[0], i)) continue;
    let end = i + parts[0].length; // exkluzivně
    let gapNeg = false;
    let ok = true;
    for (let k = 1; k < parts.length && ok; k += 1) {
      let found = -1;
      for (let j = end; j <= end + MAX_ELLIPSIS_GAP_WORDS && j + parts[k].length <= words.length; j += 1) {
        if (at(parts[k], j)) {
          found = j;
          break;
        }
      }
      if (found < 0) ok = false;
      else {
        if (wordsHaveNegation(words.slice(end, found))) gapNeg = true;
        end = found + parts[k].length;
      }
    }
    if (ok) out.push({ a: i, b: end - 1, gapNeg });
  }
  return out;
}

/**
 * Citace musí mít aspoň 6 písmen a 2 slova a každá její část (dělení na „…") musí být nalezena v textu zdroje jako
 * posloupnost CELÝCH slov (po složení FOLD_SPEC); části jdou ve zdroji ZA SEBOU, s mezerou nejvýš 12 slov, a samy mají
 * aspoň 2 slova nebo 8 písmen. Obsahuje-li vynechaná mezera zápor ("nasadíme … v pátek" vs "Nasadíme, ale ne v pátek"),
 * citace NENÍ podložená.
 * "budeme nasazovat" proto NEPODLOŽÍ text "nebudeme nasazovat" (jiné slovo) a přeházená slova citaci nepodloží.
 * Je to textová shoda; neříká nic o tom, zda tvrzení z citace plyne.
 */
export function quoteSupported(quote: string, sourceText: string): boolean {
  const parts = quoteParts(quote);
  if (!parts) return false;
  return findOccurrences(parts, tokenize(sourceText).map((t) => t.w)).some((o) => !o.gapNeg);
}

// ------------------------------------------------------------------ Zápor

const NEG_WORDS = new Set([
  // česky
  'ne', 'nikdy', 'nikdo', 'nic', 'nikde', 'nikam', 'nikoli', 'nikoliv', 'nikoho', 'nikomu', 'nikym', 'nelze', 'bez',
  'zadny', 'zadna', 'zadne', 'zadneho', 'zadnou', 'zadnym', 'zadnemu', 'zadni',
  // anglicky
  'not', 'no', 'nope', 'never', 'without', 'cannot', 'nobody', 'nothing', 'none', 'neither', 'nor', 'nowhere',
  // zkratky bez apostrofu ("dont")
  'dont', 'doesnt', 'didnt', 'wont', 'isnt', 'arent', 'wasnt', 'werent', 'cant', 'couldnt', 'shouldnt', 'wouldnt',
  'havent', 'hasnt', 'hadnt', 'aint', 'mustnt', 'neednt', 'shant',
]);
/** "don't" se složí na "don t": kmen + samostatné "t". */
const EN_NT_STEMS = new Set(['don', 'doesn', 'didn', 'won', 'isn', 'aren', 'wasn', 'weren', 'couldn', 'shouldn', 'wouldn', 'haven', 'hasn', 'hadn', 'ain', 'mustn', 'needn', 'can', 'shan']);
/** Zrušení / odložení / storno mění smysl rozhodnutí stejně jako zápor. */
const NEG_STEMS = /^(?:zadn|zrus|odloz|odklad|storn|cancel|postpon)/;
/** "nej-" je nejčastěji superlativ (nejlépe, nejdřív, nejspíš); záporem jsou jen tvary sloves být a jít. */
const NEJ_VERBS = new Set(['nejde', 'nejdu', 'nejdeme', 'nejdete', 'nejdou', 'nejsem', 'nejsi', 'nejsme', 'nejste', 'nejsou']);
/**
 * Slova začínající "ne", která zápor nejsou (výslovný seznam, ne volný regex): nebo, než, neděle, nedávno, nemocnice,
 * někdo/něco/několik, nezbytné, neustále, nesmírně, a anglické next/new/need/network...
 * ponytail: seznam je ruční; slova mimo něj se berou jako zápor (konzervativně: položka jen zůstane "neověřená").
 */
const NOT_NEG = /^(?:nebo|nebot|nez|nebe|nebesa|nebesky|neco|nekdo|nekde|nekdy|nekam|nekolik\w*|nekter\w*|nedele|nedeli|nedelni|nedelou|nedelich|nedavn\w*|nemocn\w*|nemoc|nemoci|nemec\w*|nemci|nemovit\w*|neustal\w*|nesmirn\w*|nesmysl\w*|nese|nesu|nesou|nesl|nesla|nesli|neslo|nezbyt\w*|nepochyb\w*|neodklad\w*|negativ\w*|neutral\w*|nerv\w*|next|need\w*|new\w*|net|nets|network\w*|neat|near\w*|necessar\w*|neck|nest|nexus)$/;

function isNegWord(w: string): boolean {
  if (NEG_WORDS.has(w) || NEG_STEMS.test(w)) return true;
  if (w.startsWith('nej')) return NEJ_VERBS.has(w);
  return /^ne./.test(w) && !NOT_NEG.test(w);
}

function wordsHaveNegation(words: string[]): boolean {
  return words.some((w, i) => isNegWord(w) || (w === 't' && i > 0 && EN_NT_STEMS.has(words[i - 1])));
}

export function hasNegation(text: string): boolean {
  return wordsHaveNegation(foldedWords(text));
}

/** Krátká odpověď na začátku sousední klauze ("Ne, nebudeme."): zápor v ní se vztahuje k citované větě. */
const SHORT_ANSWERS = new Set(['ne', 'ano', 'no', 'yes', 'nope', 'nikoli', 'nikoliv', 'jo', 'yep', 'yeah']);
const ANSWER_WORDS = 6;

interface Scan {
  before: string[];
  inside: string[];
  after: string[];
  /** Věta s citací končí otazníkem: tázání není tvrzení. */
  question: boolean;
  gapNeg: boolean;
  /** Offset prvního slova výskytu v textu zdroje. */
  start: number;
}

/** Pro každý výskyt citace: okno od hranice klauze k hranici klauze (+ krátká odpověď v sousední klauzi). */
function scanOccurrences(quote: string, sourceText: string): Scan[] {
  const parts = rawParts(quote);
  if (parts.length === 0) return [];
  const { toks, words, brk, qm } = analyse(sourceText);
  const n = words.length;
  const clauseStart = (i: number) => { let k = i; while (k > 0 && !brk[k]) k -= 1; return k; };
  const clauseEnd = (j: number) => { let k = j + 1; while (k < n && !brk[k]) k += 1; return k; };
  return findOccurrences(parts, words).map((o) => {
    const cs = clauseStart(o.a);
    const ce = clauseEnd(o.b);
    let before = words.slice(cs, o.a);
    let after = words.slice(o.b + 1, ce);
    if (cs > 0) {
      const ps = clauseStart(cs - 1);
      if (SHORT_ANSWERS.has(words[ps])) before = [...words.slice(ps, Math.min(ps + ANSWER_WORDS, cs)), ...before];
    }
    if (ce < n && SHORT_ANSWERS.has(words[ce])) after = [...after, ...words.slice(ce, Math.min(ce + ANSWER_WORDS, clauseEnd(ce)))];
    let question = false;
    for (let k = o.a + 1; k <= ce; k += 1) if (qm[k]) question = true;
    return { before, inside: words.slice(o.a, o.b + 1), after, question, gapNeg: o.gapNeg, start: toks[o.a].s };
  });
}

/** Je ve zdroji PŘED kterýmkoli výskytem citace (v téže větě/klauzi, nebo v krátké odpovědi před ní) záporné slovo? */
export function negationBeforeQuote(quote: string, sourceText: string): boolean {
  return scanOccurrences(quote, sourceText).some((s) => wordsHaveNegation(s.before));
}

/** Je ve zdroji ZA kterýmkoli výskytem citace (do konce věty, nebo v krátké odpovědi za ní: "Ne, to jsem nemyslel") zápor? */
export function negationAfterQuote(quote: string, sourceText: string): boolean {
  return scanOccurrences(quote, sourceText).some((s) => wordsHaveNegation(s.after));
}

/**
 * Citace sedí slovo od slova, ale smysl může být opačný: citace sama, její věta, mezera za "…" nebo krátká odpověď
 * vedle ní ("Ne, nebudeme.") obsahuje zápor, který tvrzení nemá, nebo je citovaná věta otázka (otázka není rozhodnutí;
 * vypíná se `question: false` pro druhy položek, které otázku smějí citovat). Takovou shodu NEOZNAČUJEME za podloženou
 * (zůstává neověřená) a UI na ni upozorní. Zkoumají se VŠECHNY výskyty citace; riziko kteréhokoli je riziko, pokud
 * `citedRange` (rozsah citovaného segmentu v `sourceText`) nezúží výskyty na ty v citovaném segmentu.
 *
 * Parita s SQL: DB (`quote_in_text`) umí jen shodu celých slov celé citace za sebou a příznak `negation_nearby` bere
 * od klienta (jiné hodnoty zahodí, `quoteFound` z klientského `false` nikdy nezvedne). Jediná vrstva, která zápor
 * a otázku skutečně hledá, je tento validátor; ten běží na serveru před zápisem. Proto se příznak pro otázku
 * znovu používá jako `negation_nearby` (nová hodnota by v DB zmizela).
 */
export function negationRisk(
  claim: string,
  quote: string,
  sourceText: string,
  opts: { citedRange?: [number, number]; question?: boolean } = {}
): boolean {
  const claimNeg = hasNegation(claim);
  let scans = scanOccurrences(quote, sourceText);
  if (opts.citedRange) {
    const [lo, hi] = opts.citedRange;
    const own = scans.filter((s) => s.start >= lo && s.start < hi);
    if (own.length > 0) scans = own;
  }
  if (scans.length === 0) return hasNegation(quote) && !claimNeg;
  const neg = scans.some((s) => s.gapNeg || wordsHaveNegation([...s.before, ...s.inside, ...s.after]));
  return (neg && !claimNeg) || (opts.question !== false && scans.some((s) => s.question));
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
        const scope = next !== undefined ? `${seg.text} ${next.text}` : seg.text;
        const found = quote !== null && (quoteSupported(quote, seg.text) || (next !== undefined && quoteSupported(quote, scope)));
        // zápor/otázka se hledá v širším okolí (předchozí + citovaný + další segment); výskyty v sousedních segmentech
        // se ignorují, pokud je citace v citovaném segmentu
        const prev = i > 0 ? transcript.segments[i - 1] : undefined;
        const around = [prev?.text, seg.text, next?.text].filter((t): t is string => t !== undefined).join(' ');
        const lo = prev ? prev.text.length + 1 : 0;
        evidence.push({
          ref: `segment:${seg.id}`,
          quote,
          quoteFound: found,
          startMs: seg.startMs,
          endMs: seg.endMs,
          ...(found && quote !== null && negationRisk(text, quote, around, { citedRange: [lo, lo + seg.text.length], question: MUST_BE_LINKED.includes(kind) }) ? { flag: 'negation_nearby' as const } : {}),
        });
        cited.push(seg);
      }
      if (!text || evidence.length === 0) {
        rejected += 1;
        continue;
      }
      // podloženo = citace nalezena A bez upozornění na zápor; jinak neověřeno (rozhodnutí a úkoly se pak zahodí)
      const support: Support = evidence.some((e) => e.quoteFound && !e.flag) ? 'linked' : 'unverified';
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
  support: BriefSupport;
  evidence: Evidence[];
}
export interface BriefAction {
  text: string;
  kind: BriefActionKind;
  targetCardId: string | null;
  support: BriefSupport;
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
  const ground = (r: Raw, question: boolean): { support: BriefSupport; evidence: Evidence[] } | null => {
    const refs = [...new Set(arr(r.refs).filter((x): x is string => typeof x === 'string'))]
      .filter((x) => byRef.has(x))
      .slice(0, MAX_EVIDENCE);
    if (refs.length === 0) return null;
    const quote = typeof r.quote === 'string' && r.quote.trim() ? clipStr(r.quote, MAX_QUOTE_CHARS) : null;
    const hit = quote ? refs.find((x) => quoteSupported(quote, byRef.get(x)!.text)) : undefined;
    const text = clipStr(r.text, MAX_ITEM_TEXT);
    const risky = quote !== null && hit !== undefined && negationRisk(text, quote, byRef.get(hit)!.text, { question });
    const evidence: Evidence[] = refs.map((ref) => ({ ref, quote: ref === hit ? quote : null, quoteFound: ref === hit, ...(ref === hit && risky ? { flag: 'negation_nearby' as const } : {}) }));
    // linked = citace nalezena (a bez záporu navíc); sourced = odkaz na existující zdroj BEZ citace (nic se neporovnávalo);
    // unverified = citace uvedena, ale nenalezena, nebo je v ní zápor, který tvrzení nemá.
    let support: BriefSupport = quote === null ? 'sourced' : hit && !risky ? 'linked' : 'unverified';
    // Datum v textu tvrzení musí být v citovaných zdrojích (text nebo metadata), jinak neověřeno.
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
      const g = text ? ground(r, false) : null;
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
    const g = text ? ground(r, true) : null;
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
