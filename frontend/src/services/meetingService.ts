import { parseAiHttpError, AI_NETWORK_ERROR } from '../lib/ai/clientErrors';
import { SNIFF_BYTES, validateAudio } from '../lib/stt/audio';
import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { AudioCleanupError, deleteMeetingAudio, deleteProjectAudio, sweepProjectAudio } from '../lib/stt/audioCleanup';
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
 * schvalování přes RPC (transakční, idempotentní), AI analýza přes /api/intelligence/meetings/analyze (gateway).
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
  audio: MeetingAudio;
}

export type SttState = 'none' | 'submitting' | 'unknown' | 'transcribing' | 'completed' | 'failed';

/** Zvuk a stav strojového přepisu (R5). U textových porad a starších databází jsou to prázdné výchozí hodnoty. */
export interface MeetingAudio {
  consentAt: string | null;
  path: string | null;
  bytes: number | null;
  uploadedAt: string | null;
  deleteAfter: string | null;
  deletedAt: string | null;
  sttState: SttState;
  attempts: number;
  errorType: string | null;
  audioMs: number | null;
  costUsd: number | null;
  model: string | null;
  cleanupPending: boolean;
}

export interface SttSyncResult {
  state: SttState;
  providerStatus?: string;
  errorType?: string | null;
  stuck?: boolean;
  transient?: boolean;
  revision?: string;
  cleanupPending: boolean;
  audioPurged?: boolean;
  abandonDeferred?: boolean;
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
  'PT429': ['quota', 'Dosáhli jste limitu (počet porad nebo revizí přepisu).'],
};

function fail(err: { code?: string; message?: string }): never {
  const known = err.code ? SQLSTATE_MESSAGES[err.code] : undefined;
  if (known && err.code === 'PT429' && err.message) throw new MeetingServiceError('quota', err.message);
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
  audio: {
    consentAt: r.consent_at ?? null,
    path: r.audio_path ?? null,
    bytes: r.audio_bytes ?? null,
    uploadedAt: r.audio_uploaded_at ?? null,
    deleteAfter: r.audio_delete_after ?? null,
    deletedAt: r.audio_deleted_at ?? null,
    sttState: (r.stt_state ?? 'none') as SttState,
    attempts: r.stt_attempts ?? 0,
    errorType: r.stt_error_type ?? null,
    audioMs: r.stt_audio_ms ?? null,
    costUsd: r.stt_cost_usd === null || r.stt_cost_usd === undefined ? null : Number(r.stt_cost_usd),
    model: r.stt_model ?? null,
    cleanupPending: r.stt_cleanup_pending === true,
  },
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

const accessCache = new Map<string, Promise<{ aiOwner: boolean; stt: boolean }>>();

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

  /**
   * Smaže poradu. Zvuk (soubor ve Storage a data u poskytovatele přepisu) se odstraní PŘEDTÍM, ať po smazání řádku
   * nezůstane osiřelý soubor. Když je přepis vypnutý nebo nedostupný, soubor se smaže aspoň přímo ze Storage
   * (data u poskytovatele pak zmizí sama do 30 dnů).
   */
  async remove(meetingId: string, projectId?: string): Promise<void> {
    requireSupabase();
    const m = await this.get(meetingId);
    if (m && m.audio.path && !m.audio.deletedAt) {
      try {
        await this.deleteAudioFiles(projectId ?? m.projectId, meetingId);
      } catch (e) {
        if (e instanceof MeetingServiceError && e.code === 'conflict') throw new MeetingServiceError('conflict', 'Porada se právě přepisuje. Nejdřív přepis zrušte nebo počkejte, až skončí.');
        throw new MeetingServiceError('storage', 'Zvuk se nepodařilo smazat, porada zůstává. Zkuste to prosím znovu.');
      }
      await this.providerCleanupBestEffort(projectId ?? m.projectId, meetingId);
    }
    const { error } = await supabase.from('meetings').delete().eq('id', meetingId);
    if (error) fail(error);
  },

  // --- zvuk a strojový přepis (R5) ---

  /** Nová porada se zvukem: souhlas účastníků, nahrání do soukromého bucketu, registrace souboru. Nic se neodesílá poskytovateli. */
  async createAudioMeeting(input: { projectId: string; title: string; occurredAt?: string; languageHint?: 'cs' | 'en' | null; file: File; clientDurationMs?: number | null; consent: boolean }): Promise<{ meetingId: string }> {
    requireSupabase();
    const title = input.title.trim();
    if (!title) throw new MeetingServiceError('invalid', 'Zadejte název porady.');
    if (!input.consent) throw new MeetingServiceError('consent_required', 'Bez souhlasu účastníků se zvuk nezpracovává.');
    const check = await this.checkAudioFile(input.file);
    const { data: m, error } = await supabase
      .from('meetings')
      .insert({ project_id: input.projectId, title, occurred_at: input.occurredAt || new Date().toISOString(), source_kind: 'audio', language_hint: input.languageHint ?? null })
      .select('id')
      .single();
    if (error || !m) fail(error ?? {});
    const meetingId = (m as { id: string }).id;
    try {
      const { error: cErr } = await supabase.rpc('record_audio_consent', { p_meeting: meetingId });
      if (cErr) fail(cErr);
      await this.uploadAudio({ meetingId, projectId: input.projectId, file: input.file, format: check.format, mime: check.mime, clientDurationMs: input.clientDurationMs ?? null });
    } catch (e) {
      await supabase.from('meetings').delete().eq('id', meetingId); // žádná prázdná porada po neúspěchu
      throw e;
    }
    return { meetingId };
  },

  /** Kontrola souboru v prohlížeči: přípona, velikost i OBSAH (magic bytes). Server a databáze to ověří znovu. */
  async checkAudioFile(file: File): Promise<{ format: import('../lib/stt/audio').AudioFormat; mime: string }> {
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    const r = validateAudio({ name: file.name, size: file.size }, head);
    if (!r.ok) throw new MeetingServiceError(r.code, r.message);
    return { format: r.format, mime: r.mime };
  },

  async uploadAudio(input: { meetingId: string; projectId: string; file: File; format: string; mime: string; clientDurationMs: number | null }): Promise<void> {
    requireSupabase();
    const path = `${input.projectId}/${input.meetingId}/${crypto.randomUUID()}.${input.format}`;
    const up = await supabase.storage.from('meeting-audio').upload(path, input.file, { contentType: input.mime, upsert: false });
    if (up.error) throw new MeetingServiceError('upload', 'Soubor se nepodařilo nahrát. Zkuste to prosím znovu.');
    const { data: old, error } = await supabase.rpc('attach_meeting_audio', {
      p_meeting: input.meetingId,
      p_path: path,
      p_bytes: input.file.size,
      p_mime: input.mime,
      p_client_ms: input.clientDurationMs === null ? null : Math.max(0, Math.round(input.clientDurationMs)),
    });
    if (error) {
      await supabase.storage.from('meeting-audio').remove([path]); // soubor bez zápisu v databázi nesmí zůstat
      fail(error);
    }
    if (typeof old === 'string' && old) await supabase.storage.from('meeting-audio').remove([old]); // nahrazený soubor
  },

  /** Volání STT rout (server drží klíč Soniox; prohlížeč s poskytovatelem nikdy nemluví). */
  async callStt(endpoint: 'transcribe' | 'sync' | 'purge' | 'sweep', body: Record<string, unknown>): Promise<Record<string, unknown>> {
    requireSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new MeetingServiceError('unauthenticated', 'Pro přepis se musíte přihlásit.');
    let res: Response;
    try {
      res = await fetch(`/api/intelligence/meetings/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    } catch {
      throw new MeetingServiceError(AI_NETWORK_ERROR.code, AI_NETWORK_ERROR.message);
    }
    if (!res.ok) {
      const e = parseAiHttpError(res.status, await res.json().catch(() => null), 'Operace se zvukem se nezdařila. Zkuste to prosím znovu.');
      throw new MeetingServiceError(e.code, e.message);
    }
    return (await res.json()) as Record<string, unknown>;
  },

  /**
   * "Mám přístup k AI a přepisu?" -- jen UX (co zobrazit). Rozhoduje server (seznam vlastníků), tohle nic neoprávňuje. Výsledek se drží
   * podle uživatele; jakákoli chyba = bez přístupu (volby zvuku se nezobrazí, nic se neodešle).
   */
  async aiAccess(): Promise<{ aiOwner: boolean; stt: boolean }> {
    const none = { aiOwner: false, stt: false };
    if (!hasSupabaseConfig) return none;
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    const uid = sessionData.session?.user?.id;
    if (!token || !uid) return none;
    let p = accessCache.get(uid);
    if (!p) {
      p = (async () => {
        try {
          const res = await fetch('/api/intelligence/access', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
          if (!res.ok) return none;
          const j = (await res.json()) as { aiOwner?: unknown; stt?: unknown };
          return { aiOwner: j.aiOwner === true, stt: j.stt === true };
        } catch {
          return none;
        }
      })();
      accessCache.set(uid, p);
      void p.then((r) => { if (!r.aiOwner) setTimeout(() => accessCache.delete(uid), 60_000); }); // zamítnutí se po minutě ověří znovu (po změně seznamu)
    }
    return p;
  },

  async startTranscription(projectId: string, meetingId: string): Promise<{ started: boolean; state: SttState }> {
    const r = await this.callStt('transcribe', { projectId, meetingId });
    return { started: r.started === true, state: r.state as SttState };
  },

  async syncTranscription(projectId: string, meetingId: string, cancel = false): Promise<SttSyncResult> {
    return (await this.callStt('sync', { projectId, meetingId, cancel })) as unknown as SttSyncResult;
  },

  /**
   * Projektový úklid bez cronu. Mazání zvuku (po termínu, osiřelé a nepřipojené soubory) běží PŘÍMO proti Supabase pod identitou
   * uživatele: nezávisí na příznacích přepisu ani na tom, jestli je cesta /api/ai otevřená. Úklid dat u poskytovatele
   * (vyžaduje serverový klíč) se zkusí navíc, jen když nějaká čekají; selhání se tiše ignoruje a úklid zůstane čekat.
   */
  async sweepAudio(projectId: string): Promise<void> {
    if (!hasSupabaseConfig) return;
    try {
      await sweepProjectAudio(supabase, projectId);
    } catch {
      /* úklid je best-effort; ruční mazání zůstává vždy k dispozici */
    }
    await this.providerCleanupBestEffort(projectId, null);
  },

  /** Smazání zvuku porady (Storage + databáze): bez Next routy, bez klíčů poskytovatele, bez příznaků přepisu. */
  async deleteAudioFiles(projectId: string, meetingId: string): Promise<void> {
    requireSupabase();
    const { data, error } = await supabase
      .from('meetings')
      .select('id, project_id, audio_path, audio_deleted_at, stt_state')
      .eq('id', meetingId)
      .maybeSingle();
    if (error) fail(error);
    if (!data) return;
    try {
      await deleteMeetingAudio(supabase, data as never);
    } catch (e) {
      if (e instanceof AudioCleanupError) throw new MeetingServiceError(e.code === 'in_flight' ? 'conflict' : 'storage', e.message);
      throw e;
    }
  },

  async purgeAudio(projectId: string, meetingId: string): Promise<void> {
    await this.deleteAudioFiles(projectId, meetingId);
    await this.providerCleanupBestEffort(projectId, meetingId);
  },

  /**
   * Před smazáním PROJEKTU: smaže všechen zvuk projektu ze Storage (po smazání projektu k němu nemá nikdo přístup). Selže-li to,
   * vyhodí chybu a projekt se nemá mazat. Úklid dat u poskytovatele se zkusí navíc; co nejde hned, smaže poskytovatel sám do 30 dnů.
   */
  async purgeProjectAudio(projectId: string): Promise<void> {
    if (!hasSupabaseConfig) return;
    try {
      await deleteProjectAudio(supabase, projectId);
    } catch (e) {
      if (e instanceof AudioCleanupError) throw new MeetingServiceError('storage', e.message);
      throw e;
    }
    await this.providerCleanupBestEffort(projectId, null);
  },

  /** Úklid dat u poskytovatele přepisu (jen server to umí). Nedostupná route nebo nenastavený přepis nikdy nebrání mazání. */
  async providerCleanupBestEffort(projectId: string, meetingId: string | null): Promise<void> {
    try {
      const { count } = await supabase.from('stt_jobs').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('cleanup_state', 'pending');
      if (!count) return;
      if (meetingId) await this.callStt('purge', { projectId, meetingId, includeProvider: true });
      else await this.callStt('sweep', { projectId });
    } catch {
      /* zůstává ve frontě stt_jobs (cleanup_state = 'pending') a zopakuje se */
    }
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
      res = await fetch('/api/intelligence/meetings/analyze', {
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
