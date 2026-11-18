import { supabase, hasSupabaseConfig } from '../lib/supabase';
import type { Column } from '../types/kanban';
import { collaborationService } from './collaborationService';
import { computeProjectFacts, freshnessSignature, maxCardUpdatedAt, type ProjectItemLite } from '../lib/intelligence/facts';
import { mapItemRows } from '../lib/intelligence/mappers';
import type { BriefAction, BriefItem, MeetingItemKind } from '../lib/intelligence/evidence';

/**
 * Klientská vrstva Project Intelligence 2.0: uložený Project Brief, závěry z porad a podpis čerstvosti.
 * Brief generuje výhradně server (/api/ai/project-brief); tady se jen čte a zobrazuje.
 */

export interface BriefSourceLabel {
  ref: string;
  kind: string;
  label: string;
  cardId: string | null;
  meetingId: string | null;
}

export interface BriefRecord {
  runId: string;
  createdAt: string;
  model: string | null;
  rejectedCount: number;
  summary: string;
  healthNarrative: string;
  risks: BriefItem[];
  blockers: BriefItem[];
  nextActions: BriefAction[];
  openQuestions: BriefItem[];
  notesOnData: string[];
  /** Deterministická fakta, ze kterých brief vznikl (zobrazují se odděleně od interpretace AI). */
  facts: { today: string; score: number; level: string; counts: Record<string, number>; meetingDerived: Record<string, number> } | null;
  signature: string | null;
  sources: BriefSourceLabel[];
}

export interface KnowledgeItem {
  id: string;
  meetingId: string | null;
  kind: MeetingItemKind;
  text: string;
  reviewState: 'accepted' | 'applied';
  decidedAt: string | null;
  appliedCardId: string | null;
}

export class IntelligenceServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IntelligenceServiceError';
    this.code = code;
  }
}

// Stejný dotaz a limit jako server (Context Engine), aby podpis čerstvosti vycházel z týchž dat.
const ITEM_LIMIT = 200;
async function fetchItems(projectId: string): Promise<ProjectItemLite[]> {
  const { data, error } = await supabase
    .from('intelligence_items')
    .select('id, meeting_id, kind, text, review_state, decided_at, created_at, applied_card_id')
    .eq('project_id', projectId)
    .in('review_state', ['proposed', 'accepted', 'applied'])
    .order('created_at', { ascending: false })
    .limit(ITEM_LIMIT);
  return error ? [] : mapItemRows(data);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapBrief(r: any): BriefRecord {
  const out = (r.output ?? {}) as any;
  const b = out.brief ?? {};
  return {
    runId: r.id,
    createdAt: r.created_at,
    model: r.model,
    rejectedCount: r.rejected_count ?? 0,
    summary: b.summary ?? '',
    healthNarrative: b.healthNarrative ?? '',
    risks: b.risks ?? [],
    blockers: b.blockers ?? [],
    nextActions: b.nextActions ?? [],
    openQuestions: b.openQuestions ?? [],
    notesOnData: b.notesOnData ?? [],
    facts: out.facts ?? null,
    signature: typeof out.signature === 'string' ? out.signature : null,
    sources: out.sources ?? [],
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const intelligenceService = {
  /** Poslední platný (nenahrazený) Project Brief. */
  async latestBrief(projectId: string): Promise<BriefRecord | null> {
    if (!hasSupabaseConfig) throw new IntelligenceServiceError('demo', 'Project Brief vyžaduje přihlášení přes Supabase.');
    const { data, error } = await supabase
      .from('intelligence_runs')
      .select('id, created_at, model, rejected_count, output')
      .eq('project_id', projectId)
      .eq('kind', 'project_brief')
      .eq('status', 'succeeded')
      .is('superseded_at', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new IntelligenceServiceError('unknown', 'Brief se nepodařilo načíst.');
    return data?.[0] ? mapBrief(data[0]) : null;
  },

  /** Schválené závěry z porad (rozhodnutí, rizika, otevřené otázky...). */
  async listKnowledge(projectId: string): Promise<KnowledgeItem[]> {
    if (!hasSupabaseConfig) throw new IntelligenceServiceError('demo', 'Znalosti z porad vyžadují přihlášení přes Supabase.');
    const items = await fetchItems(projectId);
    return items
      .filter((i) => i.reviewState === 'accepted' || i.reviewState === 'applied')
      .map((i) => ({
        id: i.id,
        meetingId: i.meetingId,
        kind: i.kind as MeetingItemKind,
        text: i.text,
        reviewState: i.reviewState as 'accepted' | 'applied',
        decidedAt: i.decidedAt,
        appliedCardId: i.appliedCardId,
      }));
  },

  /**
   * Podpis aktuálního stavu projektu (stejná deterministická funkce jako na serveru). Liší-li se od podpisu
   * uloženého v briefu, je brief zastaralý.
   */
  async currentSignature(projectId: string, columns: Column[]): Promise<string> {
    const [activities, items] = await Promise.all([collaborationService.fetchActivities(projectId, 100), fetchItems(projectId)]);
    const facts = computeProjectFacts(columns, activities, new Date(), undefined, items);
    return freshnessSignature(facts, {
      maxCardUpdatedAt: maxCardUpdatedAt(columns),
      knowledgeItemIds: items.filter((i) => i.reviewState === 'accepted' || i.reviewState === 'applied').map((i) => i.id),
    });
  },

  /** Vygeneruje brief přes gateway (vždy výslovně vyvolané uživatelem). 409 = brief je už aktuální. */
  async generateBrief(projectId: string, force = false): Promise<{ runId: string }> {
    if (!hasSupabaseConfig) throw new IntelligenceServiceError('demo', 'Project Brief vyžaduje přihlášení přes Supabase.');
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new IntelligenceServiceError('unauthenticated', 'Pro vytvoření briefu se musíte přihlásit.');
    let res: Response;
    try {
      res = await fetch('/api/ai/project-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId, force }),
      });
    } catch {
      throw new IntelligenceServiceError('network', 'Nepodařilo se spojit se serverem.');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      if (res.status === 403 && !body?.code) {
        throw new IntelligenceServiceError('ai_disabled', 'AI funkce jsou v této instalaci zatím vypnuté.');
      }
      throw new IntelligenceServiceError((body?.code as string) ?? 'unknown', (body?.error as string) || 'Brief se nepodařilo vytvořit.');
    }
    const json = await res.json();
    return { runId: json.runId as string };
  },
};
