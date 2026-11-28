import type { SupabaseClient } from '@supabase/supabase-js';
import { AiGatewayError } from '../ai/errors';
import { NormalizeError, normalizeSonioxTokens } from './normalize';
import { SonioxClient, SonioxError } from './soniox';
import { toGatewayError } from './pipeline';

/**
 * RUN 10 – živý přepis porady (docs/run10/ARCHITECTURE.md §3). Prohlížeč streamuje zvuk PŘÍMO do Soniox real-time; server jen:
 *  1. zarezervuje segment v DB (rozpočet, organizátor, souhlas, žádný dvojí start) – `stt_live_reserve`,
 *  2. teprve potom vydá jednorázový krátkodobý klíč s `max_session_duration_seconds` = rezervace (strop nákladů u poskytovatele),
 *  3. průběžně ukládá finální tokeny (`stt_live_append`), segment vyúčtuje (`stt_live_close`) a na konci uloží JEDNU revizi přepisu.
 * Dlouhodobý klíč Soniox nikdy neopustí server; do Soniox nejdou jména, názvy porad ani projektů (stejně jako u async cesty).
 */

export const SONIOX_RT_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
export const DEFAULT_RT_MODEL = 'stt-rt-v6';
/** TESTOVACÍ ŠEV (lokální falešný Soniox, ws://127.0.0.1): v produkci se IGNORUJE, prohlížeč dostane vždy skutečnou adresu Soniox. */
export function rtWsUrl(env: Record<string, string | undefined> = process.env): string {
  const o = env.NODE_ENV !== 'production' ? env.SONIOX_RT_WS_URL_OVERRIDE?.trim() : undefined;
  return o && /^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/transcribe-websocket$/.test(o) ? o : SONIOX_RT_WS_URL;
}

type Env = Record<string, string | undefined>;

export interface LiveConfig {
  enabled: boolean;
  segmentMs: number;
  model: string;
  /** Pilot: jen vyjmenované účty (ADR RUN 09-01). Prázdné = NIKDO (fail closed), kromě lokálního vývoje s AI_ALLOW_ALL_AUTHENTICATED. */
  pilot: Set<string> | 'all';
}

export function liveConfigFromEnv(env: Env = process.env): LiveConfig {
  const n = Number.parseInt(env.MEETING_LIVE_SEGMENT_MIN ?? '', 10);
  const model = (env.SONIOX_RT_MODEL ?? DEFAULT_RT_MODEL).trim();
  const ids = (env.MEETING_PILOT_USER_IDS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const devAll = env.NODE_ENV !== 'production' && env.AI_ALLOW_ALL_AUTHENTICATED === '1' && ids.length === 0;
  return {
    enabled: env.MEETING_LIVE_ENABLED?.trim() === '1',
    segmentMs: (Number.isFinite(n) && n >= 1 && n <= 120 ? n : 30) * 60_000,
    model: /^[a-z0-9._-]{1,32}$/i.test(model) ? model : DEFAULT_RT_MODEL,
    pilot: devAll ? 'all' : new Set(ids),
  };
}

export const inLivePilot = (cfg: LiveConfig, userId: string) => cfg.pilot === 'all' || cfg.pilot.has(userId.toLowerCase());

/** Konfigurace streamu, kterou klient pošle jako první zprávu. Kontext je záměrně obecný (žádná osobní data). */
export function streamConfig(model: string) {
  return {
    model,
    audio_format: 'auto',
    language_hints: ['cs', 'en'],
    enable_language_identification: true,
    enable_speaker_diarization: true,
    enable_endpoint_detection: true,
    context: { general: [{ key: 'domain', value: 'Project meeting' }] },
  };
}

export interface LiveToken { text: string; start_ms: number; end_ms: number; speaker?: string; language?: string }

const int = (v: unknown, max = 18_000_000) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.floor(v) : null);

/** Text od klienta je nedůvěryhodný: jen finální tokeny se známými poli, rozumné délky, žádná jiná data. */
export function sanitizeTokens(raw: unknown): LiveToken[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2000) throw new AiGatewayError('bad_request', 'Neplatná část přepisu.');
  const out: LiveToken[] = [];
  for (const t of raw) {
    if (typeof t !== 'object' || t === null) continue;
    const o = t as Record<string, unknown>;
    if (typeof o.text !== 'string' || o.text.length === 0 || o.text.length > 200) continue;
    const start = int(o.start_ms);
    const end = int(o.end_ms);
    if (start === null || end === null) continue;
    const tok: LiveToken = { text: o.text, start_ms: start, end_ms: Math.max(start, end) };
    if ((typeof o.speaker === 'string' || typeof o.speaker === 'number') && /^[0-9]{1,2}$/.test(String(o.speaker))) tok.speaker = String(o.speaker);
    if (typeof o.language === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(o.language)) tok.language = o.language;
    out.push(tok);
  }
  if (out.length === 0) throw new AiGatewayError('bad_request', 'Neplatná část přepisu.');
  return out;
}

/**
 * Spojí části všech segmentů do jedné časové osy. Čísla mluvčích platí jen v rámci jednoho streamu (Soniox), proto se mluvčí
 * dalších segmentů NEslučují s prvním (poctivě „Mluvčí 2.1“ apod.; jména přiřazuje člověk).
 */
export function assembleLiveTokens(rows: { segment: number; seq: number; offset_ms: number; tokens: unknown }[]): LiveToken[] {
  const out: LiveToken[] = [];
  for (const r of [...rows].sort((a, b) => a.segment - b.segment || a.seq - b.seq)) {
    const off = Number(r.offset_ms) || 0;
    for (const t of Array.isArray(r.tokens) ? (r.tokens as LiveToken[]) : []) {
      if (typeof t?.text !== 'string') continue;
      out.push({
        text: t.text,
        start_ms: (int(t.start_ms) ?? 0) + off,
        end_ms: (int(t.end_ms) ?? 0) + off,
        ...(t.speaker ? { speaker: r.segment > 1 ? `${r.segment}.${t.speaker}` : t.speaker } : {}),
        ...(t.language ? { language: t.language } : {}),
      });
    }
  }
  return out;
}

export interface LiveCtx {
  db: SupabaseClient;
  soniox: SonioxClient | null;
  secret: string;
  meetingId: string;
  userDailyMs: number;
  globalDailyMs: number;
  cfg: LiveConfig;
}

async function rpc<T>(db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) {
    if (error.code === '42501') throw new AiGatewayError('forbidden', 'K této poradě nemáte oprávnění.');
    if (error.code === '22023' || error.code === '55000' || error.code === '54000') throw new AiGatewayError('bad_request', error.message.slice(0, 200));
    console.error('[stt-live] rpc', name, error.code);
    throw new AiGatewayError('stt_failed', 'Živý přepis se nepodařilo uložit. Zkuste to prosím znovu.');
  }
  return data as T;
}

const OUTCOME: Record<string, AiGatewayError> = {
  no_consent: new AiGatewayError('consent_required', 'Před spuštěním potvrďte, že účastníci byli o přepisu informováni.'),
  not_organizer: new AiGatewayError('forbidden', 'Přepis může spustit jen organizátor porady nebo vlastník projektu.'),
  already_live: new AiGatewayError('conflict', 'Přepis této porady už běží (možná v jiném okně).'),
  finalized: new AiGatewayError('conflict', 'Přepis této porady je už dokončený.'),
  limit: new AiGatewayError('bad_request', 'Porada dosáhla limitu délky přepisu (300 minut).'),
  budget_exceeded: new AiGatewayError('budget_exceeded', 'Denní limit minut přepisu je vyčerpaný.'),
  global_budget_exceeded: new AiGatewayError('budget_exceeded', 'Denní limit minut přepisu je vyčerpaný.'),
};

/** Začátek (nebo pokračování) segmentu: rezervace -> klíč. Bez úspěšné rezervace se poskytovatele vůbec neptáme. */
export async function liveStart(c: LiveCtx) {
  if (!c.soniox) throw new AiGatewayError('stt_disabled', 'Přepis zvuku je v této instalaci zatím vypnutý.');
  const rows = await rpc<{ outcome: string; segment: number; offset_ms: number; reserved_ms: number }[]>(c.db, 'stt_live_reserve', {
    p_server_secret: c.secret, p_meeting: c.meetingId, p_reserve_ms: c.cfg.segmentMs, p_user_daily_ms: c.userDailyMs, p_global_daily_ms: c.globalDailyMs,
  });
  const r = Array.isArray(rows) ? rows[0] : rows;
  if (!r || r.outcome !== 'started') throw OUTCOME[r?.outcome ?? ''] ?? new AiGatewayError('stt_failed', 'Přepis se nepodařilo spustit.');
  let key: { apiKey: string; expiresAt: string };
  try {
    key = await c.soniox.createTemporaryKey({ maxSessionSec: Math.floor(r.reserved_ms / 1000), clientReferenceId: `${c.meetingId}:live:${r.segment}` });
  } catch (e) {
    // a temporary key is not a stream: nothing billable exists yet in every failure case -> release the booking
    await rpc(c.db, 'stt_live_release', { p_server_secret: c.secret, p_meeting: c.meetingId, p_segment: r.segment }).catch(() => undefined);
    if (e instanceof SonioxError) throw toGatewayError(e);
    throw e;
  }
  return {
    segment: r.segment,
    offsetMs: Number(r.offset_ms),
    reservedMs: r.reserved_ms,
    apiKey: key.apiKey,
    expiresAt: key.expiresAt,
    wsUrl: rtWsUrl(),
    config: streamConfig(c.cfg.model),
  };
}

export async function liveAppend(c: LiveCtx, input: { segment: number; seq: number; tokens: unknown }) {
  const tokens = sanitizeTokens(input.tokens);
  const res = await rpc<string>(c.db, 'stt_live_append', {
    p_server_secret: c.secret, p_meeting: c.meetingId, p_segment: input.segment, p_seq: input.seq, p_tokens: tokens,
  });
  return { stored: res === 'ok', finalized: res === 'finalized' };
}

export async function liveClose(c: LiveCtx, input: { segment: number; audioMs: number | null; reason: 'paused' | 'stopped' | 'error' }) {
  const ms = await rpc<number>(c.db, 'stt_live_close', {
    p_server_secret: c.secret, p_meeting: c.meetingId, p_segment: input.segment, p_audio_ms: input.audioMs, p_reason: input.reason,
  });
  return { chargedMs: ms };
}

/** Uloží jednu revizi z uložených částí (také po zavřené kartě – obnova). Prázdný přepis = zahodit části, nic neukládat. */
export async function liveComplete(c: LiveCtx) {
  const rows = await rpc<{ segment: number; seq: number; offset_ms: number; tokens: unknown }[]>(c.db, 'stt_live_chunks', {
    p_server_secret: c.secret, p_meeting: c.meetingId,
  });
  let norm;
  try {
    norm = await normalizeSonioxTokens(assembleLiveTokens(rows ?? []));
  } catch (e) {
    if (e instanceof NormalizeError && e.code === 'empty') {
      await rpc(c.db, 'stt_live_discard', { p_server_secret: c.secret, p_meeting: c.meetingId });
      return { outcome: 'empty' as const, revision: null };
    }
    if (e instanceof NormalizeError) throw new AiGatewayError('bad_request', e.message);
    throw e;
  }
  const revision = await rpc<string>(c.db, 'stt_live_complete', {
    p_server_secret: c.secret, p_meeting: c.meetingId, p_model: c.cfg.model,
    p_transcript: {
      revision: norm.revision, speakers: norm.transcript.speakers, segments: norm.transcript.segments,
      coverage: norm.coverage, char_count: norm.charCount,
    },
  });
  return { outcome: 'completed' as const, revision };
}

export async function liveDiscard(c: LiveCtx) {
  await rpc(c.db, 'stt_live_discard', { p_server_secret: c.secret, p_meeting: c.meetingId });
  return { outcome: 'discarded' as const };
}
