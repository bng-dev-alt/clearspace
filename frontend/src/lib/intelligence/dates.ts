import { fold } from './fold';

/**
 * Návrh termínu z doslovného textu ("do pátku", "25. listopadu", "zítra", "by Friday") vůči dni porady.
 * Čistý kód, žádné AI. Výsledek je jen PŘEDVYPLNĚNÍ: termín úkolu nastavuje člověk potvrzením formuláře
 * (AI ani tento návrh nic samo nezapisuje). Nejednoznačné nebo neplatné vstupy vrací null.
 */

export type DueBasis =
  | 'explicit-date'
  | 'today'
  | 'relative-days'
  | 'weekday'
  | 'end-of-week'
  | 'next-week'
  | 'end-of-month';

export interface DueSuggestion {
  /** YYYY-MM-DD */
  date: string;
  basis: DueBasis;
  /** exact = datum je v textu celé; relative = dopočítáno vůči dni porady. */
  kind: 'exact' | 'relative';
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseKey(k: string): { y: number; m: number; d: number } | null {
  const m = DAY_RE.exec(k);
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
const key = (dt: Date) => dt.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function validDate(y: number, m: number, d: number): string | null {
  const dt = utc(y, m, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? key(dt) : null;
}
function addDays(k: string, n: number): string {
  const p = parseKey(k)!;
  return key(utc(p.y, p.m, p.d + n));
}
/** 1 = pondělí … 7 = neděle */
function isoWeekday(k: string): number {
  const p = parseKey(k)!;
  const w = utc(p.y, p.m, p.d).getUTCDay();
  return w === 0 ? 7 : w;
}

const CS_MONTHS: [RegExp, number][] = [
  [/^ledn|^leden$/, 1], [/^unor/, 2], [/^brez/, 3], [/^dubn|^duben$/, 4], [/^kvet/, 5],
  [/^cervenc|^cervence/, 7], [/^cervn|^cerven$/, 6], [/^srp/, 8], [/^zari$/, 9], [/^rij/, 10], [/^list/, 11], [/^pros/, 12],
];
const EN_MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
function monthOf(token: string): number | null {
  if (EN_MONTHS[token]) return EN_MONTHS[token];
  for (const [re, n] of CS_MONTHS) if (re.test(token)) return n;
  return null;
}

const WEEKDAYS: [RegExp, number][] = [
  [/^pondel|^monday$|^mon$/, 1], [/^uter|^tuesday$|^tue$|^tues$/, 2], [/^stred|^wednesday$|^wed$/, 3],
  [/^ctvrt|^thursday$|^thu$|^thur$|^thurs$/, 4], [/^pat(ek|ku|kem|ky)$|^friday$|^fri$/, 5],
  [/^sobot|^saturday$|^sat$/, 6], [/^nedel|^sunday$|^sun$/, 7],
];

/** Nejbližší výskyt dne `target` (1..7) STRIKTNĚ po `ref`. */
function nextWeekday(ref: string, target: number): string {
  const cur = isoWeekday(ref);
  const diff = ((target - cur + 7) % 7) || 7;
  return addDays(ref, diff);
}

/** Dnešní den porady se zadává jako YYYY-MM-DD (den v časové zóně projektu). */
export function suggestDueDate(text: string | null | undefined, refDay: string): DueSuggestion | null {
  if (!text || !parseKey(refDay)) return null;
  const raw = text.trim().slice(0, 100);
  if (!raw) return null;
  const ref = parseKey(refDay)!;
  const f = fold(raw);
  if (!f) return null;

  // 1. celé ISO datum
  let m = /\b(\d{4}) (\d{1,2}) (\d{1,2})\b/.exec(f);
  if (m) {
    const d = validDate(+m[1], +m[2], +m[3]);
    return d ? { date: d, basis: 'explicit-date', kind: 'exact' } : null;
  }
  // 2. české d.m. / d. m. yyyy (z původního textu, v foldu zmizí tečky)
  const num = /(\d{1,2})\s?\.\s?(\d{1,2})\s?\.?(?:\s?(\d{4}))?/.exec(raw);
  if (num) {
    const day = +num[1], mon = +num[2];
    if (num[3]) {
      const d = validDate(+num[3], mon, day);
      return d ? { date: d, basis: 'explicit-date', kind: 'exact' } : null;
    }
    return explicitNoYear(day, mon, ref);
  }
  // 3. den + název měsíce (cs/en, obě pořadí)
  const words = f.split(' ');
  for (let i = 0; i < words.length; i++) {
    const mon = monthOf(words[i]);
    if (mon === null) continue;
    const before = /^\d{1,2}$/.test(words[i - 1] ?? '') ? +words[i - 1] : null;
    const after = /^\d{1,2}(st|nd|rd|th)?$/.test(words[i + 1] ?? '') ? parseInt(words[i + 1], 10) : null;
    const day = before ?? after;
    if (day === null) continue;
    const yearTok = /^\d{4}$/.test(words[i + (before !== null ? 1 : 2)] ?? '') ? +words[i + (before !== null ? 1 : 2)] : null;
    if (yearTok) {
      const d = validDate(yearTok, mon, day);
      return d ? { date: d, basis: 'explicit-date', kind: 'exact' } : null;
    }
    return explicitNoYear(day, mon, ref);
  }

  // 4. relativní výrazy
  if (/\b(dnes|dneska|today)\b/.test(f)) return { date: refDay, basis: 'today', kind: 'relative' };
  if (/\b(zitra|tomorrow)\b/.test(f)) return { date: addDays(refDay, 1), basis: 'relative-days', kind: 'relative' };
  if (/\bpozitri\b/.test(f)) return { date: addDays(refDay, 2), basis: 'relative-days', kind: 'relative' };
  const inDays = /\b(?:za|in) (\d{1,3}) (?:dn\w*|days?)\b/.exec(f);
  if (inDays) return { date: addDays(refDay, +inDays[1]), basis: 'relative-days', kind: 'relative' };
  const inWeeks = /\b(?:za|in) (\d{1,2}) (?:tydn\w*|weeks?)\b/.exec(f);
  if (inWeeks) return { date: addDays(refDay, 7 * +inWeeks[1]), basis: 'relative-days', kind: 'relative' };
  if (/\b(za tyden|in a week|in one week)\b/.test(f)) return { date: addDays(refDay, 7), basis: 'relative-days', kind: 'relative' };
  if (/\b(konce mesice|konec mesice|end of (?:the )?month|eom)\b/.test(f)) {
    const last = utc(ref.y, ref.m + 1, 0);
    return { date: key(last), basis: 'end-of-month', kind: 'relative' };
  }
  if (/\b(konce tydne|konec tydne|end of (?:the )?week|eow)\b/.test(f)) {
    return { date: isoWeekday(refDay) <= 5 ? addDays(refDay, 5 - isoWeekday(refDay)) : nextWeekday(refDay, 5), basis: 'end-of-week', kind: 'relative' };
  }
  const nextWeek = /\b(pristi tyden|pristim tydnu|next week)\b/.test(f);
  const hasNext = /\b(pristi|pristiho|pristim|next)\b/.test(f);
  for (const w of words) {
    const hit = WEEKDAYS.find(([re]) => re.test(w));
    if (!hit) continue;
    let d = nextWeekday(refDay, hit[1]);
    // "příští pátek" nesmí skončit ve stejném kalendářním týdnu jako porada
    if (hasNext && weekMonday(d) === weekMonday(refDay)) d = addDays(d, 7);
    return { date: d, basis: 'weekday', kind: 'relative' };
  }
  if (nextWeek) return { date: addDays(weekMonday(refDay), 11), basis: 'next-week', kind: 'relative' }; // pátek příštího týdne
  return null;
}

function weekMonday(k: string): string {
  return addDays(k, 1 - isoWeekday(k));
}

/** Datum bez roku: nejbližší výskyt v den porady nebo po něm (prosincová porada + "5. ledna" = příští rok). */
function explicitNoYear(day: number, mon: number, ref: { y: number; m: number; d: number }): DueSuggestion | null {
  const refKey = `${ref.y}-${String(ref.m).padStart(2, '0')}-${String(ref.d).padStart(2, '0')}`;
  const thisYear = validDate(ref.y, mon, day);
  if (thisYear && thisYear >= refKey) return { date: thisYear, basis: 'explicit-date', kind: 'relative' };
  const next = validDate(ref.y + 1, mon, day);
  return next ? { date: next, basis: 'explicit-date', kind: 'relative' } : null;
}

export const DUE_BASIS_LABEL: Record<DueBasis, string> = {
  'explicit-date': 'datum z textu',
  today: 'dnes',
  'relative-days': 'relativně ke dni porady',
  weekday: 'nejbližší takový den po poradě',
  'end-of-week': 'konec týdne porady',
  'next-week': 'pátek příštího týdne',
  'end-of-month': 'konec měsíce porady',
};
