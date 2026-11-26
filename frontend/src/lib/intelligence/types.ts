/**
 * Sdílené typy Intelligence vrstvy (Project Context Engine, evidence model, Meeting Intelligence).
 * Viz docs/intelligence/ARCHITECTURE.md §6, §7.3, §8, §9.
 */

/** Zdroj, který smí model citovat. `ref` je stabilní a lidsky čitelný (viz REF_GRAMMAR). */
export type SourceKind = 'card' | 'comment' | 'check' | 'activity' | 'meeting' | 'item' | 'comm';

export interface SourceRecord {
  ref: string;
  kind: SourceKind;
  /** Text, proti kterému se ověřují citace (u karty titulek + popis). */
  text: string;
  /** Krátký popisek pro UI a prompt. */
  label?: string;
  at?: string | null;
  /** Deterministická metadata (sloupec, termín, řešitelé...). Do ověřování textu se počítají jen jako "fakta". */
  meta?: Record<string, unknown>;
}

/**
 * 'linked' = alespoň jedna citace byla (po slovech, ve správném pořadí) NALEZENA ve zdroji; 'unverified' = ne.
 * Je to JEN textová shoda, žádný důkaz, že tvrzení z citace plyne (negace, kontext). Nastavuje VÝHRADNĚ validátor.
 */
export type Support = 'linked' | 'unverified';
/** U briefu navíc 'sourced': tvrzení odkazuje na existující zdroj, ale bez citace, takže nic nebylo porovnáno. */
export type BriefSupport = Support | 'sourced';

export interface Evidence {
  ref: string;
  quote: string | null;
  quoteFound: boolean;
  /** Upozornění z validátoru: citace je v blízkosti záporu, který tvrzení nemá (smysl může být opačný). */
  flag?: 'negation_nearby';
  /** Časy doplňuje aplikace ze segmentu, nikdy model. */
  startMs?: number | null;
  endMs?: number | null;
}

// --- Přepis porady (tvar podle UMC umc.transcript 1.0, viz ARCHITECTURE §9.6) ---

export interface TranscriptSpeaker {
  id: string;
  /** Technický štítek ("Mluvčí 1") nebo jméno z textového přepisu. */
  label: string;
  /** Jméno zadané uživatelem. AI jména mluvčím nikdy nepřiřazuje. */
  displayName: string | null;
}

export interface TranscriptSegment {
  id: string;
  startMs: number | null;
  endMs: number | null;
  speakerId: string | null;
  text: string;
  language?: string;
}

export interface Transcript {
  speakers: TranscriptSpeaker[];
  segments: TranscriptSegment[];
}

export const CONTRACT_VERSION = '1.0';
