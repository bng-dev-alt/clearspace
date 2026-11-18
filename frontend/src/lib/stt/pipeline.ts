import type { SupabaseClient } from '@supabase/supabase-js';
import { AiGatewayError } from '../ai/errors';
import { estimateAudioMs, sniffAudioFamily, SNIFF_BYTES } from './audio';
import { NormalizeError, normalizeSonioxTokens } from './normalize';
import { SonioxClient, SonioxError } from './soniox';

/**
 * Přepis zvuku bez fronty a bez workeru (R5). Veškerý stav je ve sloupcích `meetings` a mění se jen přes RPC
 * (stt_reserve / stt_attach_job / stt_complete / stt_fail / ...), která jsou idempotentní a zamykají řádek porady.
 * Každý krok je krátký a spouští ho uživatel nebo otevřená stránka porady, takže nic nezávisí na úloze na pozadí,
 * která by zmizela, když Vercel uspí proces. Souběžné nebo opakované volání nikdy neodešle zvuk dvakrát a neúčtuje dvakrát.
 */

export interface SttLimits {
  userDailyMs: number;
  globalDailyMs: number;
  retentionDays: number;
  /** Platnost podepsané URL pro Soniox: fronta u poskytovatele není ohraničená, proto 2 h místo 30 min. */
  signedUrlTtlSec: number;
}

const envInt = (env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

export function sttLimitsFromEnv(env: Record<string, string | undefined> = process.env): SttLimits {
  return {
    userDailyMs: envInt(env, 'STT_DAILY_AUDIO_MIN_PER_USER', 120, 1, 100_000) * 60_000,
    globalDailyMs: envInt(env, 'STT_DAILY_AUDIO_MIN_GLOBAL', 600, 1, 10_000_000) * 60_000,
    retentionDays: envInt(env, 'STT_RETENTION_DAYS', 7, 1, 30),
    signedUrlTtlSec: 7200,
  };
}

/** Feature flag: bez `STT_ENABLED=1` všechny STT routy odpovídají 503 `stt_disabled`. */
export const sttEnabled = (env: Record<string, string | undefined> = process.env) => env.STT_ENABLED === '1';

export type SttState = 'none' | 'submitting' | 'transcribing' | 'completed' | 'failed';

interface MeetingRow {
  id: string;
  project_id: string;
  title: string;
  source_kind: string;
  language_hint: string | null;
  audio_path: string | null;
  audio_bytes: number | null;
  audio_client_ms: number | null;
  audio_deleted_at: string | null;
  audio_delete_after: string | null;
  stt_state: SttState;
  stt_job_id: string | null;
  stt_cleanup_pending: boolean;
  stt_submitted_at: string | null;
  stt_attempts: number;
  stt_error_type: string | null;
  speaker_names: Record<string, string> | null;
}

const COLS =
  'id, project_id, title, source_kind, language_hint, audio_path, audio_bytes, audio_client_ms, audio_deleted_at, audio_delete_after, stt_state, stt_job_id, stt_cleanup_pending, stt_submitted_at, stt_attempts, stt_error_type, speaker_names';

async function loadMeeting(db: SupabaseClient, meetingId: string, projectId: string): Promise<MeetingRow> {
  const { data, error } = await db.from('meetings').select(COLS).eq('id', meetingId).maybeSingle();
  // Řádek vidí jen člen projektu (RLS); cizí nebo neexistující porada = stejná odpověď, žádný únik informací.
  if (error || !data || (data as MeetingRow).project_id !== projectId || (data as MeetingRow).source_kind !== 'audio') {
    throw new AiGatewayError('not_found', 'Porada neexistuje nebo k ní nemáte přístup.');
  }
  return data as MeetingRow;
}

/** Chyba poskytovatele -> bezpečná chyba pro klienta. Do logu jde jen druh, stav a typ, nikdy text ani klíč. */
export function toGatewayError(e: SonioxError): AiGatewayError {
  console.error('[stt] provider error', e.kind, e.status, e.errorType);
  if (e.kind === 'terminal' && e.errorType === 'invalid_audio_file') return new AiGatewayError('stt_invalid_audio', 'Poskytovatel přepisu soubor nepřijal jako zvuk.');
  if (e.kind === 'terminal' && (e.status === 400 || e.status === 413)) return new AiGatewayError('stt_failed', 'Přepis se nezdařil. Zkuste to prosím znovu.');
  // config, 401/403, zůstatek (402), přechodné chyby a síť: pro uživatele "dočasně nedostupné" (zůstatek ani konfiguraci neprozrazujeme)
  return new AiGatewayError('stt_unavailable', 'Služba přepisu je dočasně nedostupná. Zkuste to prosím později.');
}

const slug = (s: string) => (/^[a-z0-9_]{1,64}$/.test(s) ? s : 'unknown');

async function sttFail(db: SupabaseClient, meetingId: string, jobId: string | null, type: string): Promise<void> {
  const { error } = await db.rpc('stt_fail', { p_meeting: meetingId, p_job_id: jobId, p_error_type: slug(type) });
  if (error) console.error('[stt] stt_fail failed', error.code);
}

function cleanTerm(s: unknown): string {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
}

/** Jména z projektu pomáhají s pravopisem; jdou do `context.terms` jako DATA (nikdy jako instrukce). */
async function buildContext(db: SupabaseClient, m: MeetingRow) {
  const terms = new Set<string>();
  for (const v of Object.values(m.speaker_names ?? {})) if (cleanTerm(v)) terms.add(cleanTerm(v));
  const { data } = await db.from('project_members').select('member:workspace_members(full_name)').eq('project_id', m.project_id);
  for (const r of (data ?? []) as unknown as { member: { full_name?: string } | { full_name?: string }[] | null }[]) {
    const mem = Array.isArray(r.member) ? r.member[0] : r.member;
    if (cleanTerm(mem?.full_name)) terms.add(cleanTerm(mem?.full_name));
  }
  const { data: p } = await db.from('projects').select('name').eq('id', m.project_id).maybeSingle();
  const general: { key: string; value: string }[] = [{ key: 'domain', value: 'Project meeting' }];
  if (cleanTerm((p as { name?: string } | null)?.name)) general.push({ key: 'project', value: cleanTerm((p as { name?: string }).name) });
  return { general, terms: [...terms].slice(0, 100) };
}

async function fetchHead(url: string, fetchImpl: typeof fetch): Promise<Uint8Array | null> {
  try {
    const res = await fetchImpl(url, { headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` } });
    if (res.status !== 200 && res.status !== 206) return null;
    return new Uint8Array(await res.arrayBuffer()).slice(0, SNIFF_BYTES);
  } catch {
    return null;
  }
}

export interface StartResult {
  started: boolean;
  state: SttState;
  attempt?: number;
}

export async function startTranscription(a: {
  db: SupabaseClient;
  soniox: SonioxClient;
  meetingId: string;
  projectId: string;
  limits: SttLimits;
  fetchImpl?: typeof fetch;
}): Promise<StartResult> {
  const m = await loadMeeting(a.db, a.meetingId, a.projectId);
  if (!m.audio_bytes || !m.audio_path || m.audio_deleted_at) throw new AiGatewayError('stt_no_audio', 'K poradě není nahraný žádný zvuk.');

  const est = estimateAudioMs(m.audio_client_ms, Number(m.audio_bytes));
  const { data, error } = await a.db.rpc('stt_reserve', {
    p_meeting: a.meetingId,
    p_est_audio_ms: est,
    p_user_daily_ms: a.limits.userDailyMs,
    p_global_daily_ms: a.limits.globalDailyMs,
  });
  // Fail closed: bez rezervace se zvuk nikam neposílá.
  if (error) {
    if (error.code === '42501') throw new AiGatewayError('forbidden', 'K této poradě nemáte přístup.');
    if (error.code === '22023') throw new AiGatewayError('bad_request', 'Zvuk má neplatné parametry.');
    console.error('[stt] stt_reserve failed', error.code);
    throw new AiGatewayError('ai_unavailable', 'Služba přepisu je dočasně nedostupná.');
  }
  const row = Array.isArray(data) && data.length === 1 ? (data[0] as { outcome: string; attempt: number; audio_path: string | null }) : null;
  if (!row) throw new AiGatewayError('ai_unavailable', 'Služba přepisu je dočasně nedostupná.');

  switch (row.outcome) {
    case 'no_consent':
      throw new AiGatewayError('consent_required', 'Bez souhlasu účastníků se zvuk nezpracovává.');
    case 'no_audio':
      throw new AiGatewayError('stt_no_audio', 'K poradě není nahraný žádný zvuk.');
    case 'attempts_exhausted':
      throw new AiGatewayError('stt_attempts_exhausted', 'Byl vyčerpán počet pokusů o přepis. Nahrajte zvuk znovu.');
    case 'budget_exceeded':
      throw new AiGatewayError('budget_exceeded', 'Byl vyčerpán denní limit přepisu zvuku. Zkuste to prosím zítra.');
    case 'global_budget_exceeded':
      throw new AiGatewayError('ai_unavailable', 'Služba přepisu je teď vytížená. Zkuste to prosím později.');
    case 'already_done':
      return { started: false, state: 'completed' };
    case 'in_progress':
      return { started: false, state: 'transcribing' }; // idempotentní: nic se neodesílá podruhé
    case 'started':
      break;
    default:
      throw new AiGatewayError('ai_unavailable', 'Služba přepisu je dočasně nedostupná.');
  }

  // Od této chvíle je rezervace zaúčtovaná: každá cesta ven musí stav uzavřít (stt_fail), aby porada nezůstala viset.
  try {
    const signed = await a.db.storage.from('meeting-audio').createSignedUrl(row.audio_path as string, a.limits.signedUrlTtlSec);
    if (signed.error || !signed.data?.signedUrl) {
      await sttFail(a.db, a.meetingId, null, 'storage_unavailable');
      throw new AiGatewayError('stt_unavailable', 'Soubor se nepodařilo zpřístupnit. Zkuste to prosím znovu.');
    }
    // Obsah se ověří PŘED odesláním (a před jakýmkoli poplatkem): přípona a MIME jde falšovat, hlavička souboru ne.
    const head = await fetchHead(signed.data.signedUrl, a.fetchImpl ?? fetch);
    if (head === null) {
      await sttFail(a.db, a.meetingId, null, 'storage_unavailable');
      throw new AiGatewayError('stt_unavailable', 'Soubor se nepodařilo zpřístupnit. Zkuste to prosím znovu.');
    }
    if (sniffAudioFamily(head) === null) {
      await sttFail(a.db, a.meetingId, null, 'invalid_audio');
      throw new AiGatewayError('stt_invalid_audio', 'Soubor není platný zvukový záznam.');
    }
    const job = await a.soniox.createTranscription({
      audioUrl: signed.data.signedUrl,
      languageHints: m.language_hint === 'en' ? ['en', 'cs'] : ['cs', 'en'],
      context: await buildContext(a.db, m),
      clientReferenceId: a.meetingId,
    });
    const att = await a.db.rpc('stt_attach_job', { p_meeting: a.meetingId, p_job_id: job.id, p_model: job.model ?? a.soniox.model });
    if (att.error) {
      // Úloha u poskytovatele existuje, ale nepodařilo se ji zapsat: uzavřít s id, ať ji úklid později smaže.
      console.error('[stt] stt_attach_job failed', att.error.code);
      await sttFail(a.db, a.meetingId, job.id, 'attach_failed');
      throw new AiGatewayError('stt_failed', 'Přepis se nepodařilo zahájit. Zkuste to prosím znovu.');
    }
  } catch (e) {
    if (e instanceof AiGatewayError) throw e;
    if (e instanceof SonioxError) {
      await sttFail(a.db, a.meetingId, null, e.kind === 'network' ? 'network_error' : e.errorType);
      throw toGatewayError(e);
    }
    await sttFail(a.db, a.meetingId, null, 'internal_error');
    throw new AiGatewayError('stt_failed', 'Přepis se nepodařilo zahájit. Zkuste to prosím znovu.');
  }
  return { started: true, state: 'transcribing', attempt: row.attempt };
}

export interface SyncResult {
  state: SttState;
  providerStatus?: string;
  errorType?: string | null;
  /** Úloha visí příliš dlouho: UI nabídne "zkontrolovat znovu / zrušit". */
  stuck?: boolean;
  revision?: string;
  cleanupPending: boolean;
  audioPurged?: boolean;
  /** Dotaz na poskytovatele selhal přechodně; úloha není ztracená, stačí to zkusit znovu. */
  transient?: boolean;
}

const STUCK_MS = 2 * 3_600_000;

/** Smaže data úlohy u poskytovatele. Selhání není chyba: příznak zůstane a zkusí se to při dalším volání. */
async function cleanupProvider(db: SupabaseClient, soniox: SonioxClient, m: MeetingRow): Promise<boolean> {
  if (!m.stt_cleanup_pending) return false;
  if (!m.stt_job_id) {
    await db.rpc('stt_mark_cleaned', { p_meeting: m.id });
    return false;
  }
  try {
    await soniox.deleteTranscription(m.stt_job_id);
  } catch (e) {
    if (e instanceof SonioxError) console.error('[stt] cleanup deferred', e.kind, e.status, e.errorType);
    return true; // ještě běží (409), přechodná chyba nebo konfigurace: zůstává k úklidu
  }
  const { error } = await db.rpc('stt_mark_cleaned', { p_meeting: m.id });
  return !!error;
}

export async function syncTranscription(a: {
  db: SupabaseClient;
  soniox: SonioxClient;
  meetingId: string;
  projectId: string;
  limits: SttLimits;
  cancel?: boolean;
  now?: Date;
}): Promise<SyncResult> {
  const now = a.now ?? new Date();
  let m = await loadMeeting(a.db, a.meetingId, a.projectId);
  const result = (over: Partial<SyncResult> = {}): SyncResult => ({ state: m.stt_state, errorType: m.stt_error_type, cleanupPending: m.stt_cleanup_pending, ...over });

  if (a.cancel && (m.stt_state === 'submitting' || m.stt_state === 'transcribing')) {
    await sttFail(a.db, m.id, m.stt_job_id, 'cancelled');
    m = await loadMeeting(a.db, a.meetingId, a.projectId);
  }

  // --- běžící úloha ---
  if (m.stt_state === 'submitting') {
    const age = m.stt_submitted_at ? now.getTime() - Date.parse(m.stt_submitted_at) : 0;
    return result({ stuck: age > 10 * 60_000 });
  }
  if (m.stt_state === 'transcribing' && m.stt_job_id) {
    let status;
    try {
      status = await a.soniox.getTranscription(m.stt_job_id);
    } catch (e) {
      if (!(e instanceof SonioxError)) throw e;
      if (e.kind === 'not_found') {
        await sttFail(a.db, m.id, m.stt_job_id, 'transcription_not_found');
        m = await loadMeeting(a.db, a.meetingId, a.projectId);
        return result();
      }
      if (e.kind === 'retryable' || e.kind === 'network' || e.kind === 'wait') {
        console.error('[stt] status check deferred', e.kind, e.status, e.errorType);
        return result({ transient: true, stuck: m.stt_submitted_at ? now.getTime() - Date.parse(m.stt_submitted_at) > STUCK_MS : false });
      }
      throw toGatewayError(e); // 401/403/402/konfigurace: úloha zůstává, ale uživatel dostane srozumitelnou chybu
    }

    if (status.status === 'queued' || status.status === 'processing') {
      const stuck = m.stt_submitted_at ? now.getTime() - Date.parse(m.stt_submitted_at) > STUCK_MS : false;
      return result({ providerStatus: status.status, stuck });
    }
    if (status.status === 'error') {
      await sttFail(a.db, m.id, m.stt_job_id, status.errorType ?? 'transcription_failed');
      m = await loadMeeting(a.db, a.meetingId, a.projectId);
      const pending = await cleanupProvider(a.db, a.soniox, m);
      return result({ cleanupPending: pending });
    }

    // completed
    let tokens: unknown[];
    try {
      tokens = (await a.soniox.getTranscript(m.stt_job_id)).tokens;
    } catch (e) {
      if (e instanceof SonioxError && (e.kind === 'retryable' || e.kind === 'network' || e.kind === 'wait')) return result({ transient: true, providerStatus: 'completed' });
      if (e instanceof SonioxError) throw toGatewayError(e);
      throw e;
    }
    let normalized;
    try {
      normalized = await normalizeSonioxTokens(tokens);
    } catch (e) {
      if (!(e instanceof NormalizeError)) throw e;
      await sttFail(a.db, m.id, m.stt_job_id, e.code === 'empty' ? 'empty_transcript' : 'transcript_too_long');
      m = await loadMeeting(a.db, a.meetingId, a.projectId);
      const pending = await cleanupProvider(a.db, a.soniox, m);
      return result({ cleanupPending: pending });
    }
    const audioMs = status.audioDurationMs ?? normalized.durationMs;
    const done = await a.db.rpc('stt_complete', {
      p_meeting: m.id,
      p_job_id: m.stt_job_id,
      p_model: status.model ?? a.soniox.model,
      p_audio_ms: Math.min(18_000_000, Math.max(0, audioMs)),
      p_transcript: {
        revision: normalized.revision,
        speakers: normalized.transcript.speakers,
        segments: normalized.transcript.segments,
        coverage: normalized.coverage,
        char_count: normalized.charCount,
      },
      p_retention_days: a.limits.retentionDays,
    });
    if (done.error) {
      console.error('[stt] stt_complete failed', done.error.code);
      if (done.error.code === '42501') throw new AiGatewayError('forbidden', 'K této poradě nemáte přístup.');
      return result({ transient: true });
    }
    m = await loadMeeting(a.db, a.meetingId, a.projectId);
    const pending = await cleanupProvider(a.db, a.soniox, m);
    return result({ revision: done.data as string, cleanupPending: pending });
  }

  // --- ustálený stav: dokončit úklid u poskytovatele a smazat zvuk po uplynutí retence ---
  let pending = m.stt_cleanup_pending;
  if (pending) pending = await cleanupProvider(a.db, a.soniox, m);
  let purged = false;
  if (m.audio_path && !m.audio_deleted_at && m.audio_delete_after && Date.parse(m.audio_delete_after) <= now.getTime()) {
    await purgeAudio({ db: a.db, soniox: a.soniox, meetingId: a.meetingId, projectId: a.projectId });
    purged = true;
  }
  return result({ cleanupPending: pending, audioPurged: purged });
}

export async function purgeAudio(a: {
  db: SupabaseClient;
  soniox: SonioxClient;
  meetingId: string;
  projectId: string;
  /** Smazat i data u poskytovatele (pokud jsou k úklidu). */
  includeProvider?: boolean;
}): Promise<{ audioDeleted: boolean; cleanupPending: boolean }> {
  const m = await loadMeeting(a.db, a.meetingId, a.projectId);
  if (m.stt_state === 'submitting' || m.stt_state === 'transcribing') {
    throw new AiGatewayError('conflict', 'Zvuk nelze smazat, dokud přepis běží.');
  }
  if (m.audio_path && !m.audio_deleted_at) {
    const rm = await a.db.storage.from('meeting-audio').remove([m.audio_path]);
    if (rm.error) throw new AiGatewayError('stt_failed', 'Soubor se nepodařilo smazat. Zkuste to prosím znovu.');
    const { error } = await a.db.rpc('mark_audio_deleted', { p_meeting: m.id });
    if (error) {
      console.error('[stt] mark_audio_deleted failed', error.code);
      throw new AiGatewayError('stt_failed', 'Soubor se nepodařilo smazat. Zkuste to prosím znovu.');
    }
  }
  let pending = m.stt_cleanup_pending;
  if (a.includeProvider && pending) pending = await cleanupProvider(a.db, a.soniox, m);
  return { audioDeleted: true, cleanupPending: pending };
}
