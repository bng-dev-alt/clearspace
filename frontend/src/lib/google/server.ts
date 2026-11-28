import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateCaller, HttpError } from '../collab/invitationServer';
import { googleConfig, secretFormat, SERVICE_SCOPE, serviceAllowedFor, serviceAllowedForAccount, serviceMode, type GoogleConfig, type GoogleService } from './config';
import { open, seal, tokenAad, isStale } from './crypto';
import { GoogleOAuthError, refreshAccessToken } from './oauth';

/** Shared server plumbing for /api/google/* and /api/drive/* (RUN 02). Route handlers only. */
export { HttpError };
export const NO_STORE = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' };

/** Czech messages the UI shows as-is. Stable codes for the client. */
export const MSG = {
  not_configured: 'Propojení s Google Diskem není na serveru nastavené.',
  gmail_not_configured: 'Propojení s Gmailem není na serveru nastavené.',
  gmail_disabled: 'Propojení s Gmailem není na serveru zapnuté.',
  /** the Google account / token endpoint (shared by Drive and Gmail), not a Drive API outage */
  google_unavailable: 'Google je dočasně nedostupný. Zkuste to prosím později.',
  not_connected: 'Nejprve připojte svůj účet Google.',
  revoked: 'Přístup k účtu Google vypršel nebo byl zrušen. Připojte účet prosím znovu.',
  unavailable: 'Google Disk je dočasně nedostupný. Zkuste to prosím později.',
  rate_limited: 'Příliš mnoho požadavků na Google Disk. Zkuste to prosím za několik minut.',
  invalid: 'Neplatný požadavek.',
  forbidden: 'K této akci nemáte oprávnění.',
  drive_not_granted: 'Účet Google nemá povolený přístup ke Google Disku. Připojte prosím Google Disk.',
  gmail_not_granted: 'Účet Google nemá povolený přístup ke Gmailu. Připojte prosím Gmail v Propojených účtech.',
  calendar_not_configured: 'Propojení s Google Kalendářem není na serveru nastavené.',
  calendar_disabled: 'Propojení s Google Kalendářem není na serveru zapnuté.',
  calendar_not_granted: 'Účet Google nemá povolený přístup ke Google Kalendáři. Připojte prosím Kalendář v Propojených účtech.',
  meetings_disabled: 'Plánování porad v Google Kalendáři není na serveru zapnuté.',
  meetings_not_granted: 'Účet Google nemá povolené vytváření událostí. Zapněte prosím „Plánování porad“ v Propojených účtech.',
} as const;
/** The refusal when the stored grant lacks the service a route needs (RUN 03/04). */
const NOT_GRANTED: Record<GoogleService, string> = { drive: MSG.drive_not_granted, gmail: MSG.gmail_not_granted, calendar: MSG.calendar_not_granted, meetings: MSG.meetings_not_granted };
export const DISABLED: Record<GoogleService, string> = { drive: MSG.not_configured, gmail: MSG.gmail_disabled, calendar: MSG.calendar_disabled, meetings: MSG.meetings_disabled };

/**
 * Structured server log of the Google integration (RUN 02B). One JSON line per event, WHITELISTED fields only: phases, booleans,
 * counts, OAuth/Postgres error CODES, HTTP statuses. Never tokens, authorization codes, secrets, cookie contents, e-mail addresses,
 * file names or provider response bodies.
 */
type LogValue = string | number | boolean | null | undefined;
export function oauthLog(phase: string, fields: Record<string, LogValue> = {}): void {
  const safe: Record<string, LogValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && v.length > 80) continue;     // never let a long (token-like) string through
    safe[k] = v;
  }
  console.info(JSON.stringify({ evt: 'google', phase, ...safe }));
}

let configLogged = false;
export function requireGoogle(notConfigured: string = MSG.not_configured): GoogleConfig {
  const cfg = googleConfig();
  if (!cfg.enabled) {
    if (!configLogged) { configLogged = true; oauthLog('config_disabled', { reason: cfg.reason }); }
    throw new HttpError(503, notConfigured, 'not_configured');
  }
  if (!configLogged) {
    configLogged = true;
    oauthLog('config', { mode: cfg.mock ? 'mock' : 'real', secretFormat: secretFormat(cfg.clientSecret), clientIdProject: `…${cfg.clientId.split('-')[0].slice(-4)}`, redirectUri: cfg.redirectUri, tokenHost: new URL(cfg.endpoints.token).host });
  }
  return cfg;
}

export async function caller(req: Request) {
  return authenticateCaller(req.headers.get('authorization'), 'Propojení s Google vyžaduje připojenou databázi.');
}

/** RUN 06: the caller of a Gmail / Calendar route; in pilot mode a non-pilot user gets exactly the OFF answer before anything else runs. */
export async function serviceCaller(req: Request, service: 'gmail' | 'calendar' | 'meetings') {
  const c = await caller(req);
  if (!serviceAllowedFor(service, c.userId)) throw new HttpError(503, DISABLED[service], `${service}_disabled`);
  return c;
}

/** Postgres error -> HTTP, keeping the database's own Czech message for the expected refusals. */
export function dbError(error: { code?: string; message?: string }, fallback = 'Požadavek se nepodařilo zpracovat.'): HttpError {
  const map: Record<string, number> = { '42501': 403, PT429: 429, '22023': 400, '28000': 401, '23505': 409 };
  const status = map[error.code ?? ''] ?? 500;
  return new HttpError(status, status === 500 ? fallback : (error.message ?? fallback), status === 500 ? 'db' : (error.code ?? 'db'));
}

/** Small JSON body with a hard size cap (no unbounded request bodies). */
export async function readJson<T>(req: Request, maxBytes = 16 * 1024): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Požadavek je příliš velký.', 'too_large');
  try { return JSON.parse(text) as T; } catch { throw new HttpError(400, MSG.invalid, 'invalid'); }
}

export function errorResponse(err: unknown, scope: string): NextResponse {
  if (err instanceof HttpError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status, headers: NO_STORE });
  // never the error object itself (could carry a provider response); its name only
  console.error(`[${scope}] failed:`, (err as Error)?.name ?? 'unknown');
  return NextResponse.json({ error: 'error', message: 'Něco se nepovedlo. Zkuste to prosím znovu.' }, { status: 500, headers: NO_STORE });
}

interface CredRow {
  user_id: string;
  status: string;
  scopes: string[];
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_expires_at: string | null;
  token_version: number;
}

async function readCreds(db: SupabaseClient, cfg: GoogleConfig, cost: number): Promise<CredRow | null> {
  const { data, error } = await db.rpc('google_credentials_get', { p_server_secret: cfg.serverSecret, p_cost: cost });
  if (error) throw dbError(error);
  return ((Array.isArray(data) ? data[0] : data) as CredRow | undefined) ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The caller's OWN Google access token (never another user's). Refreshes when it expires within 60 s; exactly one
 * concurrent request refreshes (database lease on token_version), the others wait for the stored result. A refresh
 * that Google refuses with invalid_grant marks the connection revoked. `cost` = Google API calls the caller plans.
 */
export async function getAccessToken(db: SupabaseClient, cfg: GoogleConfig, opts: { cost?: number; force?: boolean; service?: GoogleService } = {}): Promise<{ token: string; expiresAt: number; userId: string }> {
  let row = await readCreds(db, cfg, opts.cost ?? 1);
  // RUN 06 pilot: without a connection the pilot cannot be verified -> the OFF answer (a non-pilot user must not learn that it is on)
  if (!row && opts.service && opts.service !== 'drive' && serviceMode(opts.service) === 'pilot') throw new HttpError(503, DISABLED[opts.service], `${opts.service}_disabled`);
  if (!row) throw new HttpError(409, MSG.not_connected, 'not_connected');
  if (row.status === 'revoked') throw new HttpError(409, MSG.revoked, 'revoked');
  // RUN 06 pilot: a Gmail/Calendar token only for a listed user AND listed Google account (checked on every use and BEFORE the
  // grant check, so a non-pilot user gets the same answer as with the switch off; removing someone from the pilot list takes effect at once even though their stored grant still holds the scope)
  if (opts.service && opts.service !== 'drive' && serviceMode(opts.service) === 'pilot') {
    const { data: st } = await db.rpc('google_connection_status');
    const email = ((Array.isArray(st) ? st[0] : st) as { google_email?: string } | undefined)?.google_email;
    if (!serviceAllowedForAccount(opts.service, row.user_id, email)) throw new HttpError(503, DISABLED[opts.service], `${opts.service}_disabled`);
  }
  // RUN 03: one Google grant, several services. A route asks for ITS service; a token never serves a service the user
  // did not enable in ClearSpace (e.g. Gmail removed in ClearSpace while Google still holds the grant).
  if (opts.service && !row.scopes?.includes(SERVICE_SCOPE[opts.service])) {
    throw new HttpError(409, NOT_GRANTED[opts.service], `${opts.service}_not_granted`);
  }
  const fresh = (r: CredRow) => r.access_token_enc && r.access_expires_at && Date.parse(r.access_expires_at) > Date.now() + 60_000;
  if (!opts.force && fresh(row)) {
    return { token: open(cfg.keys, row.access_token_enc!, tokenAad(row.user_id, 'access')), expiresAt: Date.parse(row.access_expires_at!), userId: row.user_id };
  }
  const startVersion = row.token_version;
  const { data: leased, error: leaseErr } = await db.rpc('google_refresh_lease', { p_server_secret: cfg.serverSecret, p_token_version: startVersion });
  if (leaseErr) throw dbError(leaseErr);
  if (!leased) {
    // someone else is refreshing: wait (bounded) for the new token
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      row = await readCreds(db, cfg, 0);
      if (!row) throw new HttpError(409, MSG.not_connected, 'not_connected');
      if (row.status === 'revoked') throw new HttpError(409, MSG.revoked, 'revoked');
      if (row.token_version !== startVersion && fresh(row)) {
        return { token: open(cfg.keys, row.access_token_enc!, tokenAad(row.user_id, 'access')), expiresAt: Date.parse(row.access_expires_at!), userId: row.user_id };
      }
    }
    throw new HttpError(503, MSG.google_unavailable, 'unavailable');
  }
  let refreshToken: string;
  try { refreshToken = open(cfg.keys, row.refresh_token_enc, tokenAad(row.user_id, 'refresh')); } catch {
    // wrong/rotated-away key: the stored credential is unusable -> the user must reconnect
    await db.rpc('google_connection_mark', { p_server_secret: cfg.serverSecret, p_status: 'revoked', p_error_code: 'undecryptable' });
    throw new HttpError(409, MSG.revoked, 'revoked');
  }
  try {
    const t = await refreshAccessToken(cfg, refreshToken);
    const expiresAt = Date.now() + t.expiresIn * 1000;
    const newRefresh = t.refreshToken ?? (isStale(cfg.keys, row.refresh_token_enc) ? refreshToken : undefined);
    const { error } = await db.rpc('google_refresh_store', {
      p_server_secret: cfg.serverSecret,
      p_token_version: startVersion,
      p_access_token_enc: seal(cfg.keys, t.accessToken, tokenAad(row.user_id, 'access')),
      p_access_expires_at: new Date(expiresAt).toISOString(),
      p_refresh_token_enc: newRefresh ? seal(cfg.keys, newRefresh, tokenAad(row.user_id, 'refresh')) : null,
    });
    if (error) throw dbError(error);
    return { token: t.accessToken, expiresAt, userId: row.user_id };
  } catch (err) {
    if (err instanceof GoogleOAuthError && (err.code === 'invalid_grant' || err.code === 'unauthorized_client')) {
      await db.rpc('google_connection_mark', { p_server_secret: cfg.serverSecret, p_status: 'revoked', p_error_code: err.code });
      throw new HttpError(409, MSG.revoked, 'revoked');
    }
    if (err instanceof GoogleOAuthError) {
      await db.rpc('google_connection_mark', { p_server_secret: cfg.serverSecret, p_status: 'active', p_error_code: err.code });
      throw new HttpError(503, MSG.google_unavailable, 'unavailable');
    }
    throw err;
  }
}

/**
 * RUN 03: a short-lived access token LIMITED to `scopes`, for code that runs in the browser (the Google Picker). The stored
 * grant may also hold Gmail; the browser must never receive a token that can read the mailbox. Asks Google for a narrower
 * token (refresh grant with `scope`), never stores it, and refuses when Google answers with more than was asked for.
 */
export async function getNarrowAccessToken(db: SupabaseClient, cfg: GoogleConfig, scopes: string[], service: GoogleService = 'drive'): Promise<{ token: string; expiresAt: number }> {
  const row = await readCreds(db, cfg, 1);
  if (!row) throw new HttpError(409, MSG.not_connected, 'not_connected');
  if (row.status === 'revoked') throw new HttpError(409, MSG.revoked, 'revoked');
  if (!row.scopes?.includes(SERVICE_SCOPE[service])) throw new HttpError(409, NOT_GRANTED[service], `${service}_not_granted`);
  let refreshToken: string;
  try { refreshToken = open(cfg.keys, row.refresh_token_enc, tokenAad(row.user_id, 'refresh')); } catch { throw new HttpError(409, MSG.revoked, 'revoked'); }
  try {
    const t = await refreshAccessToken(cfg, refreshToken, scopes);
    const extra = t.scopes.filter((s) => !scopes.includes(s) && !/^(openid|email|profile|https:\/\/www\.googleapis\.com\/auth\/userinfo\.(email|profile))$/.test(s));
    oauthLog('narrow_token', { asked: scopes.length, granted: t.scopes.length, extra: extra.length });
    if (extra.length) throw new HttpError(503, 'Výběr z Disku se nepodařilo bezpečně připravit (Google nevrátil omezené oprávnění). Zkuste to prosím později.', 'narrow_token_refused');
    return { token: t.accessToken, expiresAt: Date.now() + t.expiresIn * 1000 };
  } catch (err) {
    if (err instanceof GoogleOAuthError && (err.code === 'invalid_grant' || err.code === 'unauthorized_client')) {
      await db.rpc('google_connection_mark', { p_server_secret: cfg.serverSecret, p_status: 'revoked', p_error_code: err.code });
      throw new HttpError(409, MSG.revoked, 'revoked');
    }
    if (err instanceof GoogleOAuthError) throw new HttpError(503, MSG.google_unavailable, 'unavailable');
    throw err;
  }
}

/** RUN 03: Gmail routes need the Google integration AND the Gmail feature switch (independent of Drive). */
export function requireGmail(): GoogleConfig {
  // the switch first: with Gmail off (production default) every Gmail route says exactly that, whatever the Google config
  // (RUN 06 'pilot' passes here; the per-user/account pilot check is in getAccessToken and oauth/start|complete)
  if (serviceMode('gmail') === 'off') throw new HttpError(503, MSG.gmail_disabled, 'gmail_disabled');
  return requireGoogle(MSG.gmail_not_configured);
}

/** RUN 04: Calendar routes need the Google integration AND the Calendar feature switch (independent of Drive and Gmail). */
export function requireCalendar(): GoogleConfig {
  // the switch first: with Calendar off (production default) every Calendar route says exactly that, whatever the Google config
  if (serviceMode('calendar') === 'off') throw new HttpError(503, MSG.calendar_disabled, 'calendar_disabled');
  return requireGoogle(MSG.calendar_not_configured);
}

/** Run a Google call with the caller's own token for `service`; one forced refresh when Google says the token is stale. */
export async function withServiceToken<T extends { ok: boolean; reason?: string }>(service: GoogleService, db: SupabaseClient, cfg: GoogleConfig, cost: number, call: (token: string) => Promise<T>): Promise<T> {
  const first = await call((await getAccessToken(db, cfg, { cost, service })).token);
  if (first.ok || first.reason !== 'auth') return first;
  return call((await getAccessToken(db, cfg, { cost: 1, force: true, service })).token);
}
/** RUN 03 name, unchanged behaviour (Gmail routes call it). */
export const withGmailToken = <T extends { ok: boolean; reason?: string }>(db: SupabaseClient, cfg: GoogleConfig, cost: number, call: (token: string) => Promise<T>) =>
  withServiceToken('gmail', db, cfg, cost, call);

export const GMAIL_STATUS: Record<string, number> = { not_found: 404, auth: 409, rate_limited: 429, forbidden: 403, unavailable: 503, too_large: 413 };
