import type { MeetingStatus, ReviewState } from '../../services/meetingService';
import type { MeetingItemKind } from '../../lib/intelligence/evidence';

export const STATUS_LABEL: Record<MeetingStatus, string> = {
  draft: 'Koncept',
  uploaded: 'Nahráno',
  transcribing: 'Přepisuje se',
  transcribed: 'Přepis hotov',
  analyzing: 'Analyzuje se',
  ready: 'Ke schválení',
  failed: 'Chyba',
};

/** Kroky stavového pruhu: Přepis → Analýza → Ke schválení → Hotovo. */
export const STEPS = ['Přepis', 'Analýza', 'Ke schválení', 'Hotovo'] as const;

export function stepIndex(status: MeetingStatus, pending: number, total: number): number {
  if (status === 'ready') return total > 0 && pending === 0 ? 3 : 2;
  if (status === 'analyzing') return 1;
  if (status === 'transcribed') return 1;
  return 0;
}

export const KIND_LABEL: Record<MeetingItemKind, string> = {
  decision: 'Rozhodnutí',
  action_item: 'Úkoly',
  follow_up: 'Navazující kroky',
  risk: 'Rizika',
  blocker: 'Blokátory',
  open_question: 'Otevřené otázky',
};

export const KIND_ORDER: MeetingItemKind[] = ['decision', 'action_item', 'follow_up', 'risk', 'blocker', 'open_question'];

export const STATE_LABEL: Record<ReviewState, string> = {
  proposed: 'Návrh',
  accepted: 'Přijato',
  rejected: 'Zamítnuto',
  applied: 'Použito',
  superseded: 'Nahrazeno',
};

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
