import { REF_PATTERN } from './context';
import type { SourceRecord } from './types';

/**
 * Citace v odpovědi chatu (ARCHITECTURE §7.2): model cituje zdroje jako [card:ID] / [comment:ID] / [item:ID]...
 * Server očísluje jen ty, které opravdu byly v kontextu, a v textu je nahradí [1], [2]...
 * Odkaz na neexistující zdroj se z textu odstraní (nesmí vzniknout falešná citace).
 */
export interface Citation {
  n: number;
  ref: string;
  kind: SourceRecord['kind'];
  label: string;
  /** Karta, kterou lze otevřít (u card: je to ona sama, u komentáře/checklistu karta, ke které patří). */
  cardId: string | null;
  meetingId: string | null;
}

const MARKER = /\[((?:card|comment|check|activity|item):[^\]\s]+|meeting:[^\]\s]+#[^\]\s]+)\]/g;

export function linkCitations(content: string, sources: SourceRecord[]): { content: string; citations: Citation[] } {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const numbers = new Map<string, number>();
  const citations: Citation[] = [];

  const text = content.replace(MARKER, (_m, ref: string) => {
    const src = byRef.get(ref);
    if (!REF_PATTERN.test(ref) || !src) return ''; // neexistující zdroj -> bez citace
    let n = numbers.get(ref);
    if (n === undefined) {
      n = citations.length + 1;
      numbers.set(ref, n);
      const meta = (src.meta ?? {}) as Record<string, unknown>;
      citations.push({
        n,
        ref,
        kind: src.kind,
        label: src.label ?? src.text.slice(0, 80),
        cardId: src.kind === 'card' ? ref.slice(5) : typeof meta.cardId === 'string' ? meta.cardId : typeof meta.appliedCardId === 'string' ? meta.appliedCardId : null,
        meetingId: typeof meta.meetingId === 'string' ? meta.meetingId : null,
      });
    }
    return `[${n}]`;
  });
  return { content: text.replace(/[ \t]+([.,;:!?])/g, '$1').replace(/ {2,}/g, ' '), citations };
}
