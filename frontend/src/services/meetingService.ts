import { parseAiHttpError, AI_NETWORK_ERROR } from '../lib/ai/clientErrors';
import { supabase, hasSupabaseConfig } from '../lib/supabase';
import {
  parseTranscript,
  transcriptRevision,
  TranscriptParseError,
  type TranscriptSource,
} from '../lib/intelligence/transcript';
import type { Evidence, Support, Transcript } from '../lib/intelligence/types';
import type { MeetingItemKind } from '../lib/intelligence/evidence';

/**
 * Klientská vrstva Meeting Intelligence. Čtení a vytvoření porady/přepisu jde přímo přes Supabase (RLS),
 * schvalování přes RPC (transakční, idempotentní), AI analýza přes /api/ai/meetings/analyze (gateway).
 * Služba sama NIKDY nemění projekt: karty vznikají jen voláním apply() po lidském potvrzení.
 */

export type MeetingStatus = 'draft' | 'uploaded' | 'transcribing' | 'transcribed' | 'analyzing' | 'ready' | 'failed';
export type ReviewState = 'proposed' | 'accepted' | 'rejected' | 'applied' | 'superseded';

export interface Meeting {
  id: string;
  projectId: string;
  title: string;
  occurredAt: string;
  sourceKind: 'text' | 'audio';
  status: MeetingStatus;
  currentRevision: string | null;
  speakerNames: Record<string, string>;
  languageHint: 'cs' | 'en' | null;
  createdAt: string;
}

export interface MeetingRun {
  id: string;
  createdAt: string;
  model: string | null;
  promptVersion: string;
  rejectedCount: number;
  summary: string;
  chapters: { title: string; firstSegment: string; lastSegment: string }[];
  /** Revize přepisu, ze které analýza vznikla (liší-li se od aktuální revize porady, je analýza zastaralá). */
  transcriptRevision: string;
}

export interface TranscriptRevision {
  revision: string;
  parentRevision: string | null;
  source: string;
  createdAt: string;
  charCount: number;
  editNote: string | null;
  /** Existuje k této revizi (nenahrazená) analýza? */
  analyzed: boolean;
}

export interface IntelligenceItem {
  id: string;
  meetingId: string | null;
  runId: string;
  ordinal: number;
  kind: MeetingItemKind;
  text: string;
  support: Support;
  evidence: Evidence[];
  ownerText: string | null;
  dueText: string | null;
  suggestedCardId: string | null;
  reviewState: ReviewState;
  assigneeMemberId: string | null;
  dueDate: string | null;
  appliedCardId: string | null;
  appliedMode: 'create_card' | 'link_card' | 'comment' | null;
  duplicateOf: string | null;
}

export type ApplyTarget =
  | { mode: 'create_card'; column_id: string; title?: string; details?: string; due_date?: string | null; assignee_member_id?: string | null; allow_duplicate?: boolean }
  | { mode: 'link_card'; card_id: string; add_comment?: boolean }
  | { mode: 'comment'; card_id: string };

/** Chyba služby se srozumitelným českým textem a kódem pro UI. */
export class MeetingServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MeetingServiceError';
    this.code = code;
  }
}

const SQLSTATE_MESSAGES: Record<string, [string, string]> = {
  '42501': ['forbidden', 'K této akci nemáte oprávnění.'],
  '23505': ['duplicate', 'Stejná položka už existuje (duplicita).'],
  '55000': ['state', 'Položka je v jiném stavu, než akce vyžaduje. Obnovte stránku.'],
  '22023': ['invalid', 'Neplatná hodnota. Zkontrolujte vyplněné údaje.'],
  '22008': ['invalid', 'Neplatné datum.'],
  '23514': ['invalid', 'Neplatná hodnota. Zkontrolujte vyplněné údaje.'],
  // R6: kvóty (počet porad / revizí). Text vyhazuje databáze česky a je bezpečný k zobrazení.
  '53400': ['quota', 'Dosáhli jste limitu (počet porad nebo revizí přepisu).'],
};

function fail(err: { code?: string; message?: string }): never {
  const known = err.code ? SQLSTATE_MESSAGES[err.code] : undefined;
  if (known && err.code === '53400' && err.message) throw new MeetingServiceError('quota', err.message);
  if (known) throw new MeetingServiceError(known[0], known[1]);
  throw new MeetingServiceError('unknown', 'Operace se nezdařila. Zkuste to prosím znovu.');
}

function requireSupabase() {
  if (!hasSupabaseConfig) {
    throw new MeetingServiceError('demo', 'Porady vyžadují přihlášení přes Supabase a v demo režimu nejsou dostupné.');
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const mapMeeting = (r: any): Meeting => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  occurredAt: r.occurred_at,
  sourceKind: r.source_kind,
  status: r.status,
  currentRevision: r.current_revision,
  speakerNames: (r.speaker_names ?? {}) as Record<string, string>,
  languageHint: r.language_hint,
  createdAt: r.created_at,
});

const mapItem = (r: any): IntelligenceItem => ({
  id: r.id,
  meetingId: r.meeting_id,
  runId: r.run_id,
  ordinal: r.ordinal,
  kind: r.kind,
  text: r.text,
  support: r.support,
  evidence: (r.evidence ?? []) as Evidence[],
  ownerText: r.owner_text,
  dueText: r.due_text,
  suggestedCardId: r.suggested_card_id,
  reviewState: r.review_state,
  assigneeMemberId: r.assignee_member_id,
  dueDate: r.due_date,
  appliedCardId: r.applied_card_id,
  appliedMode: r.applied_mode,
  duplicateOf: r.duplicate_of,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface NewMeetingInput {
  projectId: string;
  title: string;
  occurredAt?: string;
  text: string;
  source: TranscriptSource;
  languageHint?: 'cs' | 'en' | null;
}

export const meetingService = {
  async list(projectId: string): Promise<Meeting[]> {
    requireSupabase();
    const { data, error } = await supabase
      .from('meetings')
      .select('*')
      .eq('project_id', projectId)
      .order('occurred_at', { ascending: false });
    if (error) fail(error);
    return (data ?? []).map(mapMeeting);
  },

  /** Počet položek čekajících na rozhodnutí (proposed) podle porady; pro seznam. */
  async pendingCounts(projectId: string): Promise<Record<string, number>> {
    requireSupabase();
    const { data, error } = await supabase
      .from('intelligence_items')
      .select('meeting_id')
      .eq('project_id', projectId)
      .eq('review_state', 'proposed');
    if (error) fail(error);
    const out: Record<string, number> = {};
    for (const r of data ?? []) {
      const id = (r as { meeting_id: string | null }).meeting_id;
      if (id) out[id] = (out[id] ?? 0) + 1;
    }
    return out;
  },

  async get(meetingId: string): Promise<Meeting | null> {
    requireSupabase();
    const { data, error } = await supabase.from('meetings').select('*').eq('id', meetingId).maybeSingle();
    if (error) fail(error);
    return data ? mapMeeting(data) : null;
  },

  /**
   * Zpracuje text v prohlížeči (parser je čistá funkce), pak uloží poradu a přepis. Když uložení přepisu selže,
   * porada se odstraní, aby nezůstala prázdná. Při chybě parseru se do DB nezapíše nic.
   */
  async createWithTranscript(input: NewMeetingInput): Promise<{ meetingId: string; warnings: string[] }> {
    requireSupabase();
    const title = input.title.trim();
    if (!title) throw new MeetingServiceError('invalid', 'Zadejte název porady.');
    let parsed;
    try {
      parsed = parseTranscript(input.text, input.source);
    } catch (e) {
      if (e instanceof TranscriptParseError) throw new MeetingServiceError(e.code, e.message);
      throw e;
    }
    const revision = await transcriptRevision(parsed.transcript);
    const { data: m, error } = await supabase
      .from('meetings')
      .insert({
        project_id: input.projectId,
        title,
        occurred_at: input.occurredAt || new Date().toISOString(),
        source_kind: 'text',
        language_hint: input.languageHint ?? null,
      })
      .select('id')
      .single();
    if (error || !m) fail(error ?? {});
    const meetingId = (m as { id: string }).id;
    const { error: tErr } = await supabase.from('meeting_transcripts').insert({
      meeting_id: meetingId,
      project_id: input.projectId,
      revision,
      source: input.source,
      speakers: parsed.transcript.speakers,
      segments: parsed.transcript.segments,
      char_count: parsed.charCount,
    });
    if (tErr) {
      await supabase.from('meetings').delete().eq('id', meetingId);
      fail(tErr);
    }
    return { meetingId, warnings: parsed.warnings };
  },

  async getTranscript(meetingId: string, revision: string): Promise<Transcript | null> {
    requireSupabase();
    const { data, error } = await supabase
      .from('meeting_transcripts')
      .select('speakers, segments')
      .eq('meeting_id', meetingId)
      .eq('revision', revision)
      .maybeSingle();
    if (error) fail(error);
    return data ? ({ speakers: data.speakers, segments: data.segments } as Transcript) : null;
  },

  /** Historie revizí přepisu (nejnovější první). Revize jsou neměnné; úprava vždy vytvoří novou. */
  async listRevisions(meetingId: string): Promise<TranscriptRevision[]> {
    requireSupabase();
    const [revs, runs] = await Promise.all([
      supabase
        .from('meeting_transcripts')
        .select('revision, parent_revision, source, created_at, char_count, edit_note')
        .eq('meeting_id', meetingId)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('intelligence_runs')
        .select('transcript_revision')
        .eq('meeting_id', meetingId)
        .eq('kind', 'meeting_brief')
        .eq('status', 'succeeded')
        .is('superseded_at', null),
    ]);
    if (revs.error) fail(revs.error);
    const analyzed = new Set(((runs.data ?? []) as { transcript_revision: string }[]).map((r) => r.transcript_revision));
    return ((revs.data ?? []) as any[]).map((r) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      revision: r.revision,
      parentRevision: r.parent_revision ?? null,
      source: r.source,
      createdAt: r.created_at,
      charCount: r.char_count,
      editNote: r.edit_note ?? null,
      analyzed: analyzed.has(r.revision),
    }));
  },

  /**
   * Úprava přepisu = NOVÁ neměnná revize s odkazem na předchůdce. Text projde stejným parserem jako vložení.
   * Stejný obsah jako existující revize (revize = hash obsahu) se odmítne jako "beze změny".
   */
  async addRevision(input: { meetingId: string; projectId: string; text: string; parentRevision: string; note?: string }): Promise<{ revision: string; warnings: string[] }> {
    requireSupabase();
    let parsed;
    try {
      parsed = parseTranscript(input.text, 'paste');
    } catch (e) {
      if (e instanceof TranscriptParseError) throw new MeetingServiceError(e.code, e.message);
      throw e;
    }
    const revision = await transcriptRevision(parsed.transcript);
    if (revision === input.parentRevision) throw new MeetingServiceError('unchanged', 'Přepis se nezměnil.');
    const { error } = await supabase.from('meeting_transcripts').insert({
      meeting_id: input.meetingId,
      project_id: input.projectId,
      revision,
      source: 'edit',
      parent_revision: input.parentRevision,
      edit_note: input.note?.trim() ? input.note.trim().slice(0, 500) : null,
      speakers: parsed.transcript.speakers,
      segments: parsed.transcript.segments,
      char_count: parsed.charCount,
    });
    if (error) {
      if (error.code === '23505') throw new MeetingServiceError('unchanged', 'Tato verze přepisu už existuje.');
      fail(error);
    }
    return { revision, warnings: parsed.warnings };
  },

  /** Aktivní běh (nezastaralý) s shrnutím a kapitolami. */
  async latestRun(meetingId: string): Promise<MeetingRun | null> {
    requireSupabase();
    const { data, error } = await supabase
      .from('intelligence_runs')
      .select('id, created_at, model, prompt_version, rejected_count, output, transcript_revision')
      .eq('meeting_id', meetingId)
      .eq('kind', 'meeting_brief')
      .eq('status', 'succeeded')
      .is('superseded_at', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) fail(error);
    const r = data?.[0];
    if (!r) return null;
    const out = (r.output ?? {}) as { summary?: string; chapters?: MeetingRun['chapters'] };
    return {
      id: r.id,
      createdAt: r.created_at,
      model: r.model,
      promptVersion: r.prompt_version,
      rejectedCount: r.rejected_count,
      summary: out.summary ?? '',
      chapters: out.chapters ?? [],
      transcriptRevision: r.transcript_revision,
    };
  },

  /** Položky porady (zastaralé `superseded` se neukazují). */
  async listItems(meetingId: string): Promise<IntelligenceItem[]> {
    requireSupabase();
    const { data, error } = await supabase
      .from('intelligence_items')
      .select('*')
      .eq('meeting_id', meetingId)
      .neq('review_state', 'superseded')
      .order('ordinal', { ascending: true });
    if (error) fail(error);
    return (data ?? []).map(mapItem);
  },

  async renameSpeakers(meetingId: string, names: Record<string, string>): Promise<void> {
    requireSupabase();
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(names)) if (v.trim()) clean[k] = v.trim().slice(0, 100);
    const { error } = await supabase.from('meetings').update({ speaker_names: clean }).eq('id', meetingId);
    if (error) fail(error);
  },

  async remove(meetingId: string): Promise<void> {
    requireSupabase();
    const { error } = await supabase.from('meetings').delete().eq('id', meetingId);
    if (error) fail(error);
  },

  /** Členové projektu (pro výběr řešitele). */
  async projectMembers(projectId: string): Promise<{ id: string; fullName: string }[]> {
    requireSupabase();
    const { data, error } = await supabase
      .from('project_members')
      .select('member:workspace_members(id, full_name)')
      .eq('project_id', projectId);
    if (error) fail(error);
    return (data ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any) => (Array.isArray(r.member) ? r.member[0] : r.member))
      .filter(Boolean)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((m: any) => ({ id: m.id as string, fullName: m.full_name as string }));
  },

  /** AI analýza přes gateway. Volání je vždy výslovně vyvolané uživatelem. */
  async analyze(projectId: string, meetingId: string, force = false): Promise<{ itemCount: number; rejectedCount: number }> {
    requireSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new MeetingServiceError('unauthenticated', 'Pro analýzu se musíte přihlásit.');
    let res: Response;
    try {
      res = await fetch('/api/ai/meetings/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId, meetingId, force }),
      });
    } catch {
      throw new MeetingServiceError(AI_NETWORK_ERROR.code, AI_NETWORK_ERROR.message);
    }
    if (!res.ok) {
      const e = parseAiHttpError(res.status, await res.json().catch(() => null), 'Analýza se nezdařila. Zkuste to prosím znovu.');
      throw new MeetingServiceError(e.code, e.code === 'conflict' ? 'Tento přepis už byl analyzován.' : e.message);
    }
    const json = await res.json();
    return { itemCount: json.itemCount ?? 0, rejectedCount: json.rejectedCount ?? 0 };
  },

  async review(itemId: string, decision: 'accept' | 'reject' | 'reopen', edits: { text?: string; assignee_member_id?: string | null; due_date?: string | null } = {}): Promise<void> {
    requireSupabase();
    const { error } = await supabase.rpc('review_intelligence_item', { p_item: itemId, p_decision: decision, p_edits: edits });
    if (error) fail(error);
  },

  /** Jediné místo, kde z návrhu vzniká karta/komentář. Volá se výhradně po potvrzení uživatelem. */
  async apply(itemId: string, target: ApplyTarget): Promise<{ cardId: string; alreadyApplied: boolean }> {
    requireSupabase();
    const { data, error } = await supabase.rpc('apply_intelligence_item', { p_item: itemId, p_target: target });
    if (error) fail(error);
    return { cardId: (data as { card_id: string }).card_id, alreadyApplied: !!(data as { already_applied?: boolean }).already_applied };
  },

  async undo(itemId: string, force = false): Promise<void> {
    requireSupabase();
    const { error } = await supabase.rpc('undo_intelligence_item', { p_item: itemId, p_force: force });
    if (error) fail(error);
  },
};
