import { fold, foldedWords } from './fold';
import { tokenInWords } from './evidence';
import { aliasInWords } from './names';

/** Deterministické pomocníky pro schvalování (žádné AI): kandidáti na duplicitu a návrh řešitele. */

const STOP = new Set(['pro', 'jak', 'aby', 'ale', 'nebo', 'jsou', 'jsme', 'bude', 'byl', 'tak', 'the', 'and', 'for', 'with', 'that', 'this']);

function tokens(s: string): Set<string> {
  return new Set(foldedWords(s).filter((w) => w.length >= 3 && !STOP.has(w)));
}

export function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export interface CardRef {
  id: string;
  title: string;
}

/** Otevřené karty, jejichž název se výrazně překrývá s textem položky (Jaccard ≥ 0.6, nejvýše `limit`). */
export function candidateDuplicateCards(text: string, cards: CardRef[], threshold = 0.6, limit = 3): (CardRef & { score: number })[] {
  return cards
    .map((c) => ({ ...c, score: jaccard(text, c.title) }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface MemberRef {
  id: string;
  fullName: string;
}

/**
 * Návrh řešitele z `owner_text`: členové, jejichž jméno obsahuje KAŽDÉ slovo vlastníka (česká koncovka tolerována).
 * Vrací id jen když je shoda právě jedna; nejednoznačnost nebo žádná shoda = null. Nikdy se nevybírá automaticky.
 */
export function suggestAssignee(ownerText: string | null, members: MemberRef[]): string | null {
  if (!ownerText) return null;
  const wanted = foldedWords(ownerText);
  if (wanted.length === 0) return null;
  const hits = members.filter((m) => {
    const words = foldedWords(m.fullName);
    return wanted.every((w) => tokenInWords(w, words) || aliasInWords(w, words));
  });
  return hits.length === 1 ? hits[0].id : null;
}

/** Stabilní klíč pro detekci shodných položek (stejný druh + stejný složený text). */
export function dedupeSource(kind: string, text: string): string {
  return `${kind}:${fold(text)}`;
}
