import { createHash } from 'node:crypto';
import { aiService } from '../../services/ai/aiService';
import type { AiMessage } from '../../services/ai/types';
import { AiFeature } from './gateway';
import { AiGatewayError } from './errors';
import { record } from './validate';
import { VALIDATOR_VERSION, validateProjectBrief } from '../intelligence/evidence';
import { freshnessSignature, maxCardUpdatedAt } from '../intelligence/facts';
import { UNTRUSTED_DATA_RULES } from '../intelligence/frame';
import type { ProjectContext } from '../intelligence/context';

/**
 * Project Brief (ARCHITECTURE §7.2): Gemini jen INTERPRETUJE deterministická fakta a cituje zdroje z kontextu.
 * Skóre zdraví, počty a seznamy počítá kód; výstup projde validátorem (neexistující ref = zahozeno) a uloží se
 * jednou transakcí (RPC persist_project_brief). Brief nikdy nemění úkoly ani nepřiřazuje lidi/termíny.
 */

export const BRIEF_PROMPT_VERSION = 'project-brief-p1';
export const BRIEF_CONTRACT = 'cs.project-brief@1.0';

const SYSTEM = `Jste analytik projektů pro nástroj ClearSpace. Z dat projektu připravíte Project Brief jako JSON podle schématu.

Pravidla (závazná):
1. Fakta v sekci FACTS (skóre a úroveň zdraví, počty, seznamy id, nedávné změny, závěry z porad) spočítala aplikace a jsou závazná. Nepřepočítávejte je, neměňte skóre ani úroveň zdraví a nepřidávejte vlastní čísla.
2. Vy INTERPRETUJETE: summary (nejvýše 5 vět), health_narrative (nejvýše 3 věty, vysvětluje fakta, nic nového netvrdí), rizika, blokátory, doporučené kroky a otevřené otázky.
3. KAŽDÉ riziko, blokátor, doporučený krok a otevřená otázka MUSÍ mít refs: 1 až 4 hodnoty přesně tak, jak jsou v datech v hranatých závorkách (např. card:abc, comment:xyz, item:123). Položka bez platného refs se zahodí. Volitelně quote = doslovná citace z jednoho z odkazovaných zdrojů.
4. Nevymýšlejte osoby, termíny ani fakta. Jména a data v textu smí být jen taková, která jsou v odkazovaných zdrojích. Pole pro vlastníka ani termín neexistují.
5. Doporučený krok: kind je create, update, unblock, assign nebo clarify; target_card_id jen id existující karty z dat, jinak null. Nic se neprovádí automaticky: jde o doporučení pro člověka.
6. Závěry z porad (item:...) schválil člověk. Ostatní tvrzení o poradách nedělejte.
7. Maxima: 8 rizik, 8 blokátorů, 5 kroků, 8 otázek. Prázdné pole je v pořádku.

${UNTRUSTED_DATA_RULES}
Vraťte pouze JSON.`;

export function buildBriefPrompt(context: ProjectContext): AiMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Data projektu:\n${context.rendered}\n\nVytvořte Project Brief.` },
  ];
}

export function briefFingerprint(contextFingerprint: string): string {
  return createHash('sha256').update(`${BRIEF_PROMPT_VERSION}|${contextFingerprint}`).digest('hex');
}

export const projectBrief: AiFeature<{ force: boolean }> = {
  name: 'project-brief',
  needsProject: true,
  structured: true,
  contextPurpose: 'brief',
  maxOutputTokens: 4096,
  maxBodyBytes: 2048,
  parse: (b) => ({ force: record(b, 'body').force === true }),
  prepare: async ({ db, input, projectId, context }) => {
    if (!context) throw new AiGatewayError('bad_request', 'Chybí kontext projektu.');
    if (!input.force) {
      // Stejný vstup = stejný brief: nic se neplatí, klient dostane 409 a zobrazí aktuální uložený brief.
      const { data } = await db
        .from('intelligence_runs')
        .select('id')
        .eq('project_id', projectId)
        .eq('kind', 'project_brief')
        .eq('status', 'succeeded')
        .is('superseded_at', null)
        .eq('input_fingerprint', briefFingerprint(context.fingerprint))
        .limit(1);
      if (Array.isArray(data) && data.length > 0) {
        throw new AiGatewayError('conflict', 'Brief je aktuální: data projektu se od posledního briefu nezměnila.');
      }
    }
    return null;
  },
  run: ({ context }) => {
    if (!context) throw new AiGatewayError('bad_request', 'Chybí kontext projektu.');
    return aiService.executeProjectBrief(buildBriefPrompt(context));
  },
  finalize: async ({ db, project, context, board, parsed, response, requestId }) => {
    if (!context || !project) throw new AiGatewayError('bad_request', 'Chybí kontext projektu.');
    const activeCardIds = board.flatMap((c) => c.cards.filter((k) => !k.archived).map((k) => k.id));
    const result = validateProjectBrief(parsed, context.sources, { activeCardIds });
    if (!result.ok) throw new AiGatewayError('bad_model_output', 'AI vrátila neúplný brief. Zkuste to prosím znovu.');
    const v = result.value;

    // Popisky použitých zdrojů pro UI (navigace na kartu / poradu), jen ke zdrojům, které brief opravdu cituje.
    const used = new Set<string>();
    for (const c of [...v.risks, ...v.blockers, ...v.nextActions, ...v.openQuestions]) for (const e of c.evidence) used.add(e.ref);
    const byRef = new Map(context.sources.map((s) => [s.ref, s]));
    const sources = [...used].map((ref) => {
      const s = byRef.get(ref)!;
      const meta = (s.meta ?? {}) as Record<string, unknown>;
      return {
        ref,
        kind: s.kind,
        label: s.label ?? s.text.slice(0, 80),
        cardId: s.kind === 'card' ? ref.slice(5) : typeof meta.cardId === 'string' ? meta.cardId : typeof meta.appliedCardId === 'string' ? meta.appliedCardId : null,
        meetingId: typeof meta.meetingId === 'string' ? meta.meetingId : null,
      };
    });

    const f = context.facts;
    const output = {
      brief: {
        summary: v.summary,
        healthNarrative: v.healthNarrative,
        risks: v.risks,
        blockers: v.blockers,
        nextActions: v.nextActions,
        openQuestions: v.openQuestions,
        notesOnData: v.notesOnData,
      },
      // Snímek deterministických faktů, ze kterých brief vznikl (zobrazuje se odděleně od interpretace AI).
      facts: { today: f.today, score: f.health.score, level: f.health.level, counts: f.counts, meetingDerived: f.meetingDerived },
      signature: freshnessSignature(f, { maxCardUpdatedAt: maxCardUpdatedAt(context.columns), knowledgeItemIds: context.knowledgeItemIds }),
      sources,
      truncated: context.truncated,
    };
    const { data, error } = await db.rpc('persist_project_brief', {
      p_project_id: project.id,
      p_run: {
        status: 'succeeded',
        input_fingerprint: briefFingerprint(context.fingerprint),
        contract_version: BRIEF_CONTRACT,
        prompt_version: BRIEF_PROMPT_VERSION,
        validator_version: VALIDATOR_VERSION,
        model: response.model,
        ai_request_id: requestId,
        rejected_count: v.rejectedCount,
        output,
      },
    });
    if (error) {
      if (error.code === '42501') throw new AiGatewayError('forbidden', 'K tomuto projektu nemáte přístup.');
      console.error('[project-brief] persist failed', error.code);
      throw new AiGatewayError('ai_failed', 'Brief se nepodařilo uložit. Zkuste to prosím znovu.');
    }
    return { runId: data as string, rejectedCount: v.rejectedCount };
  },
};
