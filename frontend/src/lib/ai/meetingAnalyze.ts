import type { SupabaseClient } from '@supabase/supabase-js';
import { aiService } from '../../services/ai/aiService';
import { AiFeature } from './gateway';
import { AiGatewayError } from './errors';
import { record } from './validate';
import { validateMeetingBrief } from '../intelligence/evidence';
import {
  buildMeetingPrompt,
  buildPersistPayload,
  inputFingerprint,
  MEETING_PROMPT_VERSION,
  withSpeakerNames,
} from '../intelligence/meetingBrief';
import { MAX_TRANSCRIPT_CHARS } from '../intelligence/transcript';
import type { Transcript } from '../intelligence/types';

/**
 * Analýza porady (ARCHITECTURE §8): přepis se NAČÍTÁ NA SERVERU pod identitou volajícího (klient posílá jen
 * meetingId), výstup modelu projde deterministickým validátorem a uloží se jednou transakcí (RPC persist_meeting_run).
 * Žádná změna projektu: vznikají jen návrhy (`proposed`), karty vznikají až po lidském schválení.
 */

interface Prepared {
  meeting: { id: string; title: string; languageHint: 'cs' | 'en' | null };
  transcript: Transcript;
  revision: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadMeeting(db: SupabaseClient, meetingId: string, projectId: string): Promise<Prepared> {
  const { data: m, error } = await db
    .from('meetings')
    .select('id, project_id, title, language_hint, speaker_names, current_revision')
    .eq('id', meetingId)
    .maybeSingle();
  // RLS: nečlen porady nevidí -> stejná odpověď jako neexistující (žádná věštírna).
  if (error || !m || m.project_id !== projectId) throw new AiGatewayError('not_found', 'Porada nebyla nalezena.');
  if (!m.current_revision) throw new AiGatewayError('bad_request', 'Porada zatím nemá přepis.');

  const { data: t, error: tErr } = await db
    .from('meeting_transcripts')
    .select('revision, speakers, segments, char_count')
    .eq('meeting_id', meetingId)
    .eq('revision', m.current_revision)
    .maybeSingle();
  if (tErr || !t) throw new AiGatewayError('bad_request', 'Přepis porady nebyl nalezen.');
  if (typeof t.char_count === 'number' && t.char_count > MAX_TRANSCRIPT_CHARS) {
    throw new AiGatewayError('bad_request', 'Přepis je příliš dlouhý k analýze (max 400 000 znaků).');
  }
  const transcript = withSpeakerNames(
    { speakers: (t.speakers ?? []) as Transcript['speakers'], segments: (t.segments ?? []) as Transcript['segments'] },
    m.speaker_names as Record<string, unknown>
  );
  return {
    meeting: { id: m.id as string, title: m.title as string, languageHint: (m.language_hint as 'cs' | 'en' | null) ?? null },
    transcript,
    revision: t.revision as string,
  };
}

export const meetingAnalyze: AiFeature<{ meetingId: string; force: boolean }> = {
  name: 'meeting-analyze',
  needsProject: true,
  structured: true,
  contextPurpose: 'meeting',
  maxOutputTokens: 8192,
  maxBodyBytes: 4096,
  parse: (b) => {
    const r = record(b, 'body');
    const id = r.meetingId;
    if (typeof id !== 'string' || !UUID.test(id)) throw new AiGatewayError('bad_request', 'Neplatný identifikátor porady.');
    return { meetingId: id.toLowerCase(), force: r.force === true };
  },
  prepare: async ({ db, input, projectId }) => {
    const prepared = await loadMeeting(db, input.meetingId, projectId);
    if (!input.force) {
      // Idempotence PŘED rezervací a voláním modelu: stejná revize + verze promptu se platí jednou.
      const { data: existing } = await db
        .from('intelligence_runs')
        .select('id')
        .eq('meeting_id', input.meetingId)
        .eq('transcript_revision', prepared.revision)
        .eq('prompt_version', MEETING_PROMPT_VERSION)
        .eq('kind', 'meeting_brief')
        .eq('status', 'succeeded')
        .is('superseded_at', null)
        .limit(1);
      if (Array.isArray(existing) && existing.length > 0) {
        throw new AiGatewayError('conflict', 'Tento přepis už byl analyzován. Pro novou analýzu ji spusťte znovu s potvrzením.');
      }
    }
    return prepared;
  },
  // Přepis je největší část promptu: bez něj by rezervace kvóty u dlouhých porad drasticky podhodnocovala.
  estimateExtraChars: (prepared) => {
    const p = prepared as Prepared;
    return p.transcript.segments.reduce((n, s) => n + s.text.length + 24, 0) + 4000; // + instrukce
  },
  run: ({ prepared, context }) => {
    const p = prepared as Prepared;
    return aiService.executeMeetingBrief(
      buildMeetingPrompt({
        title: p.meeting.title,
        transcript: p.transcript,
        projectContext: context?.rendered ?? '',
        outputLanguage: p.meeting.languageHint === 'en' ? 'en' : 'cs',
      })
    );
  },
  finalize: async ({ db, input, prepared, parsed, response, requestId, context, board }) => {
    const p = prepared as Prepared;
    const activeCardIds = board.flatMap((c) => c.cards.filter((k) => !k.archived).map((k) => k.id));
    const result = validateMeetingBrief(parsed, p.transcript, { activeCardIds });
    if (!result.ok) {
      // Nic se neukládá; předchozí výsledek zůstává platný.
      throw new AiGatewayError('bad_model_output', 'AI vrátila neúplný zápis. Zkuste to prosím znovu.');
    }
    const v = result.value;
    const payload = buildPersistPayload(v, {
      revision: p.revision,
      fingerprint: inputFingerprint(p.revision, context?.fingerprint ?? ''),
      model: response.model,
      aiRequestId: requestId,
    });
    const { data, error } = await db.rpc('persist_meeting_run', {
      p_meeting_id: p.meeting.id,
      p_run: payload.run,
      p_items: payload.items,
      p_force: input.force,
    });
    if (error) {
      if (error.code === '23505') throw new AiGatewayError('conflict', 'Tento přepis už byl analyzován.');
      if (error.code === '42501') throw new AiGatewayError('forbidden', 'K této poradě nemáte přístup.');
      console.error('[meeting-analyze] persist failed', error.code);
      throw new AiGatewayError('ai_failed', 'Výsledek analýzy se nepodařilo uložit. Zkuste to prosím znovu.');
    }
    return {
      runId: data as string,
      itemCount: v.items.length,
      rejectedCount: v.rejectedCount,
      nulledFields: v.nulledFields,
    };
  },
};
