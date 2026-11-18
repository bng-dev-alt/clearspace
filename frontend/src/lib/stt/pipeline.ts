import type { SupabaseClient } from '@supabase/supabase-js';
import { AiGatewayError } from '../ai/errors';
import { estimateAudioMs, sniffAudioFamily, SNIFF_BYTES } from './audio';
import { NormalizeError, normalizeSonioxTokens } from './normalize';
import { SonioxClient, SonioxError } from './soniox';

/**
 * Přepis zvuku bez fronty a bez workeru (R5). Stav je v databázi (`meetings`, `stt_jobs`) a mění se jen přes RPC, která zamykají
 * řádek porady, takže LOKÁLNÍ přechody stavů jsou idempotentní. Důvěryhodné zápisy (rezervace, připojení úlohy, dokončení, selhání,
 * úklid) vyžadují serverové tajemství (`p_server_secret`): člen projektu je přímo se svým JWT zavolat nemůže.
 *
 * Co tento kód GARANTUJE a co NE:
 *  - lokální stav a účtování v DB: přesně jednou na pokus (zámek řádku, jedinečná reference pokusu);
 *  - u poskytovatele NE: Soniox neumí idempotentní vytvoření přepisu. Placený POST se proto nikdy neopakuje automaticky;
 *    nejistý výsledek (timeout, 5xx, pád procesu) se zjišťuje výpisem úloh podle `client_reference_id` a do vyřešení zůstává
 *    odhad ceny v rozpočtu. Zbylé riziko: úloha vytvořená těsně před pádem, kterou výpis nenajde (zaplnění stránkování), se
 *    uzavře jen výslovným "vzdát se" uživatele a zůstane v rozpočtu jako nejistá.
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

/** Serverové tajemství pro důvěryhodné RPC (min. 32 znaků). Bez něj STT neběží (fail closed). */
export function sttServerSecret(env: Record<string, string | undefined> = process.env): string {
  const s = env.STT_SERVER_SECRET?.trim();
  if (!s || s.length < 32) throw new AiGatewayError('stt_unavailable', 'Služba přepisu není nastavena.');
  return s;
}

export type SttState = 'none' | 'submitting' | 'unknown' | 'transcribing' | 'completed' | 'failed';

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
}

const COLS =
  'id, project_id, title, source_kind, language_hint, audio_path, audio_bytes, audio_client_ms, audio_deleted_at, audio_delete_after, stt_state, stt_job_id, stt_cleanup_pending, stt_submitted_at, stt_attempts, stt_error_type';

const BUCKET = 'meeting-audio';

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

/**
 * Po tomto selhání poskytovatel JISTĚ úlohu nevytvořil (odmítl požadavek dřív): nic se neúčtuje a opakování je bezpečné.
 * Vše ostatní (timeout, síť, 5xx, 408) je NEJISTÉ: úloha mohla vzniknout.
 */
export function definitelyNotCreated(e: SonioxError): boolean {
  if (e.kind === 'config' || e.kind === 'budget' || e.kind === 'not_found') return true;
  if (e.kind === 'terminal') return true; // 400/401/403/413: požadavek odmítnut
  return e.status === 429; // limit_exceeded: odmítnuto před zpracováním
}

const slug = (s: string) => (/^[a-z0-9_]{1,64}$/.test(s) ? s : 'unknown');

type Billing = 'none' | 'uncertain' | 'estimated' | 'actual';

/** Důvěryhodné RPC: připojí serverové tajemství. */
async function trusted(db: SupabaseClient, secret: string, name: string, args: Record<string, unknown>) {
  return db.rpc(name, { p_server_secret: secret, ...args });
}

async function sttFail(db: SupabaseClient, secret: string, meetingId: string, jobId: string | null, type: string, billing: Billing, audioMs?: number): Promise<void> {
  const { error } = await trusted(db, secret, 'stt_fail', { p_meeting: meetingId, p_job_id: jobId, p_error_type: slug(type), p_billing: billing, p_audio_ms: audioMs ?? null });
  if (error) console.error('[stt] stt_fail failed', error.code);
}

async function fetchHead(url: string, fetchImpl: typeof fetch): Promise<Uint8Array | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetchImpl(url, { headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` }, signal: ctl.signal });
    if (res.status !== 200 && res.status !== 206) return null;
    return new Uint8Array(await res.arrayBuffer()).slice(0, SNIFF_BYTES);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SttCtx {
  db: SupabaseClient;
  soniox: SonioxClient;
  secret: string;
  meetingId: string;
  projectId: string;
  limits: SttLimits;
  fetchImpl?: typeof fetch;
}

export interface StartResult {
  started: boolean;
  state: SttState;
  attempt?: number;
}

export async function startTranscription(a: SttCtx): Promise<StartResult> {
  const m = await loadMeeting(a.db, a.meetingId, a.projectId);
  if (!m.audio_bytes || !m.audio_path || m.audio_deleted_at) throw new AiGatewayError('stt_no_audio', 'K poradě není nahraný žádný zvuk.');

  // Odhad i limity určuje SERVER (z řádku porady a prostředí); klient je nijak neovlivní.
  const est = estimateAudioMs(m.audio_client_ms, Number(m.audio_bytes));
  const { data, error } = await trusted(a.db, a.secret, 'stt_reserve', {
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
  const row = Array.isArray(data) && data.length === 1 ? (data[0] as { outcome: string; attempt: number; audio_path: string | null; client_reference: string | null }) : null;
  if (!row) throw new AiGatewayError('ai_unavailable', 'Služba přepisu je dočasně nedostupná.');

  switch (row.outcome) {
    case 'no_consent':
      throw new AiGatewayError('consent_required', 'Bez souhlasu účastníků se zvuk nezpracovává.');
    case 'no_audio':
      throw new AiGatewayError('stt_no_audio', 'K poradě není nahraný žádný zvuk.');
    case 'attempts_exhausted':
      throw new AiGatewayError('stt_attempts_exhausted', 'Byl vyčerpán počet pokusů o přepis. Založte novou poradu.');
    case 'budget_exceeded':
      throw new AiGatewayError('budget_exceeded', 'Byl vyčerpán denní limit přepisu zvuku. Zkuste to prosím zítra.');
    case 'global_budget_exceeded':
      throw new AiGatewayError('ai_unavailable', 'Služba přepisu je teď vytížená. Zkuste to prosím později.');
    case 'already_done':
      return { started: false, state: 'completed' };
    case 'in_progress':
      return { started: false, state: 'transcribing' }; // idempotentní: nic se neodesílá podruhé
    case 'unknown_outcome':
      return { started: false, state: 'unknown' }; // předchozí odeslání má nejistý výsledek: NEOPAKUJE se, zjišťuje se
    case 'started':
      break;
    default:
      throw new AiGatewayError('ai_unavailable', 'Služba přepisu je dočasně nedostupná.');
  }
  const ref = row.client_reference as string;

  // Od této chvíle je rezervace zaúčtovaná: každá cesta ven musí stav uzavřít, aby porada nezůstala viset.
  const signed = await a.db.storage.from(BUCKET).createSignedUrl(row.audio_path as string, a.limits.signedUrlTtlSec);
  if (signed.error || !signed.data?.signedUrl) {
    await sttFail(a.db, a.secret, a.meetingId, null, 'storage_unavailable', 'none');
    throw new AiGatewayError('stt_unavailable', 'Soubor se nepodařilo zpřístupnit. Zkuste to prosím znovu.');
  }
  // Obsah se ověří PŘED odesláním (a před jakýmkoli poplatkem): přípona a MIME jde falšovat, hlavička souboru ne.
  const head = await fetchHead(signed.data.signedUrl, a.fetchImpl ?? fetch);
  if (head === null) {
    await sttFail(a.db, a.secret, a.meetingId, null, 'storage_unavailable', 'none');
    throw new AiGatewayError('stt_unavailable', 'Soubor se nepodařilo zpřístupnit. Zkuste to prosím znovu.');
  }
  if (sniffAudioFamily(head) === null) {
    await sttFail(a.db, a.secret, a.meetingId, null, 'invalid_audio', 'none');
    throw new AiGatewayError('stt_invalid_audio', 'Soubor není platný zvukový záznam.');
  }

  let jobId: string;
  let model: string;
  try {
    // Soukromí: poskytovateli se neposílají jména členů, jména mluvčích ani název projektu (jen obecná doména).
    const job = await a.soniox.createTranscription({
      audioUrl: signed.data.signedUrl,
      languageHints: m.language_hint === 'en' ? ['en', 'cs'] : ['cs', 'en'],
      context: { general: [{ key: 'domain', value: 'Project meeting' }] },
      clientReferenceId: ref,
    });
    jobId = job.id;
    model = job.model ?? a.soniox.model;
  } catch (e) {
    if (e instanceof SonioxError && definitelyNotCreated(e)) {
      await sttFail(a.db, a.secret, a.meetingId, null, e.errorType, 'none');
      throw toGatewayError(e);
    }
    // NEJISTÝ výsledek: úloha mohla vzniknout a být účtována. Neopakuje se; odhad zůstává v rozpočtu; zjistí se výpisem.
    const type = e instanceof SonioxError ? (e.kind === 'network' ? 'network_error' : e.errorType) : 'internal_error';
    const { error: uErr } = await trusted(a.db, a.secret, 'stt_mark_unknown', { p_meeting: a.meetingId, p_error_type: slug(type) });
    if (uErr) console.error('[stt] stt_mark_unknown failed', uErr.code);
    if (e instanceof SonioxError) console.error('[stt] POST outcome unknown', e.kind, e.status, e.errorType);
    return { started: true, state: 'unknown', attempt: row.attempt };
  }

  // Úloha u poskytovatele EXISTUJE: její id se zapíše; při selhání zápisu se jednou opakuje, jinak jde stav do "unknown"
  // (výpis podle client_reference_id ji pak najde a převezme, nic se neodesílá podruhé).
  let att = await trusted(a.db, a.secret, 'stt_attach_job', { p_meeting: a.meetingId, p_job_id: jobId, p_model: model });
  if (att.error) att = await trusted(a.db, a.secret, 'stt_attach_job', { p_meeting: a.meetingId, p_job_id: jobId, p_model: model });
  if (att.error) {
    console.error('[stt] stt_attach_job failed', att.error.code);
    await trusted(a.db, a.secret, 'stt_mark_unknown', { p_meeting: a.meetingId, p_error_type: 'attach_failed' });
    return { started: true, state: 'unknown', attempt: row.attempt };
  }
  if (att.data === 'orphaned') {
    // uživatel mezitím zrušil: id úlohy je uložené a čeká na smazání u poskytovatele
    await runCleanup(a);
    return { started: false, state: 'failed', attempt: row.attempt };
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
const UNKNOWN_WAIT_MS = 10 * 60_000;
const LIST_PAGE = 100;
const LIST_MAX_PAGES = 10;

interface JobRow {
  id: string;
  provider_job_id: string | null;
  cleanup_attempts: number;
}

/** Smaže data čekajících úloh u poskytovatele (nejvýše 10 za volání). Selhání není chyba: zkusí se znovu s odstupem. */
export async function runCleanup(a: SttCtx, scope: { meetingScoped: boolean } = { meetingScoped: true }): Promise<number> {
  let q = a.db.from('stt_jobs').select('id, provider_job_id, cleanup_attempts').eq('project_id', a.projectId).eq('cleanup_state', 'pending').lte('cleanup_due_at', new Date().toISOString());
  if (scope.meetingScoped) q = q.eq('meeting_id', a.meetingId);
  const { data } = await q.limit(10);
  for (const j of (data ?? []) as JobRow[]) {
    if (!j.provider_job_id) {
      await trusted(a.db, a.secret, 'stt_cleanup_result', { p_job: j.id, p_result: 'abandon', p_error_type: 'no_provider_id' });
      continue;
    }
    try {
      await a.soniox.deleteTranscription(j.provider_job_id);
      await trusted(a.db, a.secret, 'stt_cleanup_result', { p_job: j.id, p_result: 'done' });
    } catch (e) {
      const type = e instanceof SonioxError ? (e.kind === 'wait' ? 'still_running' : e.kind === 'network' ? 'network_error' : e.errorType) : 'internal_error';
      if (e instanceof SonioxError) console.error('[stt] cleanup deferred', e.kind, e.status, e.errorType);
      await trusted(a.db, a.secret, 'stt_cleanup_result', { p_job: j.id, p_result: 'retry', p_error_type: slug(type) });
    }
  }
  return pendingCleanupCount(a, scope.meetingScoped);
}

async function pendingCleanupCount(a: SttCtx, meetingScoped: boolean): Promise<number> {
  let q = a.db.from('stt_jobs').select('id', { count: 'exact', head: true }).eq('project_id', a.projectId).eq('cleanup_state', 'pending');
  if (meetingScoped) q = q.eq('meeting_id', a.meetingId);
  const { count } = await q;
  return count ?? 0;
}

/** Výpis úloh u poskytovatele: najde úlohu podle client_reference_id (jediný způsob, jak zjistit nejistý výsledek). */
async function findProviderJob(a: SttCtx, reference: string): Promise<{ found: { id: string; model: string | null } | null; complete: boolean }> {
  let cursor: string | null = null;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const r = await a.soniox.listTranscriptions(LIST_PAGE, cursor);
    const hit = r.items.find((i) => i.clientReferenceId === reference);
    if (hit) return { found: { id: hit.id, model: hit.model }, complete: false };
    if (!r.nextCursor) return { found: null, complete: true };
    cursor = r.nextCursor;
  }
  return { found: null, complete: false }; // výpis se nevešel do limitu stránek: NELZE tvrdit, že úloha neexistuje
}

export async function syncTranscription(a: SttCtx & { cancel?: boolean; now?: Date }): Promise<SyncResult> {
  const now = a.now ?? new Date();
  let m = await loadMeeting(a.db, a.meetingId, a.projectId);
  const result = async (over: Partial<SyncResult> = {}): Promise<SyncResult> => {
    const pending = over.cleanupPending ?? (m.stt_cleanup_pending ? await pendingCleanupCount(a, true) > 0 : false);
    return { state: m.stt_state, errorType: m.stt_error_type, ...over, cleanupPending: pending };
  };
  const reload = async () => { m = await loadMeeting(a.db, a.meetingId, a.projectId); };

  // --- zrušení: nikdy nesmaže už vzniklé náklady (odhad zůstává v rozpočtu), id úlohy se zachová k úklidu ---
  if (a.cancel) {
    if (m.stt_state === 'transcribing') {
      await sttFail(a.db, a.secret, m.id, m.stt_job_id, 'cancelled', 'estimated');
      await reload();
    } else if (m.stt_state === 'submitting') {
      await sttFail(a.db, a.secret, m.id, null, 'cancelled', 'uncertain');
      await reload();
    } else if (m.stt_state === 'unknown') {
      await trusted(a.db, a.secret, 'stt_resolve_unknown', { p_meeting: m.id, p_resolution: 'abandon' });
      await reload();
    }
  }

  if (m.stt_state === 'submitting') {
    const age = m.stt_submitted_at ? now.getTime() - Date.parse(m.stt_submitted_at) : 0;
    return result({ stuck: age > UNKNOWN_WAIT_MS });
  }

  // --- nejistý výsledek POST: zjistit u poskytovatele, nikdy neodesílat znovu ---
  if (m.stt_state === 'unknown') {
    const { data: jobs } = await a.db.from('stt_jobs').select('client_reference').eq('meeting_id', m.id).eq('attempt', m.stt_attempts).maybeSingle();
    const ref = (jobs as { client_reference?: string } | null)?.client_reference;
    if (!ref) return result({ transient: true });
    let lookup;
    try {
      lookup = await findProviderJob(a, ref);
    } catch (e) {
      if (e instanceof SonioxError && (e.kind === 'retryable' || e.kind === 'network' || e.kind === 'wait')) return result({ transient: true });
      if (e instanceof SonioxError) throw toGatewayError(e);
      throw e;
    }
    if (lookup.found) {
      await trusted(a.db, a.secret, 'stt_attach_job', { p_meeting: m.id, p_job_id: lookup.found.id, p_model: lookup.found.model ?? a.soniox.model });
      await reload();
      return result({ providerStatus: 'adopted' });
    }
    const age = m.stt_submitted_at ? now.getTime() - Date.parse(m.stt_submitted_at) : 0;
    if (lookup.complete && age > UNKNOWN_WAIT_MS) {
      await trusted(a.db, a.secret, 'stt_resolve_unknown', { p_meeting: m.id, p_resolution: 'absent' });
      await reload();
      return result();
    }
    return result({ stuck: age > STUCK_MS });
  }

  if (m.stt_state === 'transcribing' && m.stt_job_id) {
    let status;
    try {
      status = await a.soniox.getTranscription(m.stt_job_id);
    } catch (e) {
      if (!(e instanceof SonioxError)) throw e;
      if (e.kind === 'not_found') {
        await sttFail(a.db, a.secret, m.id, m.stt_job_id, 'transcription_not_found', 'none');
        await reload();
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
      // odmítnutý soubor poskytovatel neúčtuje; jiné selhání už mohlo běžet, proto odhad zůstává
      const billing: Billing = status.errorType === 'invalid_audio_file' ? 'none' : 'estimated';
      await sttFail(a.db, a.secret, m.id, m.stt_job_id, status.errorType ?? 'transcription_failed', billing);
      await reload();
      return result({ cleanupPending: (await runCleanup(a)) > 0 });
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
      // poskytovatel úlohu ZPRACOVAL a účtuje ji: zaúčtuje se skutečná délka
      await sttFail(a.db, a.secret, m.id, m.stt_job_id, e.code === 'empty' ? 'empty_transcript' : 'transcript_too_long', 'actual', status.audioDurationMs ?? 0);
      await reload();
      return result({ cleanupPending: (await runCleanup(a)) > 0 });
    }
    const audioMs = status.audioDurationMs ?? normalized.durationMs;
    const done = await trusted(a.db, a.secret, 'stt_complete', {
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
    await reload();
    return result({ revision: done.data as string, cleanupPending: (await runCleanup(a)) > 0 });
  }

  // --- ustálený stav: dokončit úklid u poskytovatele (i po selhání / zrušení) a smazat zvuk po uplynutí retence ---
  const pending = (await runCleanup(a)) > 0;
  let purged = false;
  if (m.audio_path && !m.audio_deleted_at && m.audio_delete_after && Date.parse(m.audio_delete_after) <= now.getTime()) {
    await purgeAudio(a);
    purged = true;
  }
  return result({ cleanupPending: pending, audioPurged: purged });
}

/** Smaže zvuk ze Storage (včetně případných nepřipojených souborů ve složce porady) a teprve potom označí řádek. */
export async function purgeAudio(a: SttCtx & { includeProvider?: boolean }): Promise<{ audioDeleted: boolean; cleanupPending: boolean }> {
  const m = await loadMeeting(a.db, a.meetingId, a.projectId);
  if (m.stt_state === 'submitting' || m.stt_state === 'unknown' || m.stt_state === 'transcribing') {
    throw new AiGatewayError('conflict', 'Zvuk nelze smazat, dokud přepis běží.');
  }
  // Dva NEZÁVISLÉ úklidy (Storage a data u poskytovatele): selhání jednoho nezastaví druhý a každý se zopakuje zvlášť.
  let pending = m.stt_cleanup_pending;
  if (a.includeProvider) pending = (await runCleanup(a)) > 0;
  const prefix = `${m.project_id}/${m.id}`;
  const names = new Set<string>();
  if (m.audio_path) names.add(m.audio_path);
  // soubory, které se nahrály, ale nepřipojily (selhání registrace): jen jejich smazání je uklidí
  const listed = await a.db.storage.from(BUCKET).list(prefix);
  for (const o of (listed.data ?? []) as { name: string }[]) names.add(`${prefix}/${o.name}`);
  if (names.size > 0) {
    const rm = await a.db.storage.from(BUCKET).remove([...names]);
    if (rm.error) throw new AiGatewayError('stt_failed', 'Soubor se nepodařilo smazat. Zkuste to prosím znovu.');
  }
  if (m.audio_path && !m.audio_deleted_at) {
    const { error } = await a.db.rpc('mark_audio_deleted', { p_meeting: m.id });
    if (error) {
      console.error('[stt] mark_audio_deleted failed', error.code);
      throw new AiGatewayError('stt_failed', 'Soubor se nepodařilo smazat. Zkuste to prosím znovu.');
    }
  }
  return { audioDeleted: true, cleanupPending: pending };
}

export interface SweepResult {
  audioPurged: number;
  orphansRemoved: number;
  providerCleanupPending: number;
}

/**
 * Projektový úklid (bez cronu): smaže zvuk po termínu, osiřelé soubory smazaných porad a dokončí úklid u poskytovatele.
 * Volá ho otevřený seznam porad. Pokud do projektu nikdo nepřijde, nic se nesmaže (viz záruky retence v RELEASE_PLAN).
 */
export async function sweepProject(a: Omit<SttCtx, 'meetingId'>): Promise<SweepResult> {
  const out: SweepResult = { audioPurged: 0, orphansRemoved: 0, providerCleanupPending: 0 };
  const ctx = (meetingId: string): SttCtx => ({ ...a, meetingId });
  const due = await a.db
    .from('meetings')
    .select('id')
    .eq('project_id', a.projectId)
    .eq('source_kind', 'audio')
    .not('audio_path', 'is', null)
    .lte('audio_delete_after', new Date().toISOString())
    .not('stt_state', 'in', '(submitting,unknown,transcribing)')
    .limit(20);
  for (const r of (due.data ?? []) as { id: string }[]) {
    try {
      await purgeAudio(ctx(r.id));
      out.audioPurged += 1;
    } catch (e) {
      if (!(e instanceof AiGatewayError)) throw e; // jedna selhaná položka nezastaví úklid ostatních
    }
  }
  const orphans = await a.db.from('meeting_audio_orphans').select('path').eq('project_id', a.projectId).limit(50);
  for (const o of (orphans.data ?? []) as { path: string }[]) {
    const rm = await a.db.storage.from(BUCKET).remove([o.path]);
    if (!rm.error) {
      await a.db.from('meeting_audio_orphans').delete().eq('path', o.path);
      out.orphansRemoved += 1;
    }
  }
  out.providerCleanupPending = await runCleanup(ctx(''), { meetingScoped: false });
  return out;
}
