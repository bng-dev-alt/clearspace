import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateCaller, HttpError } from '../collab/invitationServer';
import { googleConfig, type GoogleConfig } from './config';
import { open, seal, tokenAad, isStale } from './crypto';
import { GoogleOAuthError, refreshAccessToken } from './oauth';

/** Shared server plumbing for /api/google/* and /api/drive/* (RUN 02). Route handlers only. */
export { HttpError };
export const NO_STORE = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' };

/** Czech messages the UI shows as-is. Stable codes for the client. */
export const MSG = {
  not_configured: 'Propojení s Google Diskem není na serveru nastavené.',
  not_connected: 'Nejprve připojte svůj účet Google.',
  revoked: 'Přístup k účtu Google vypršel nebo byl zrušen. Připojte účet prosím znovu.',
  unavailable: 'Google Disk je dočasně nedostupný. Zkuste to prosím později.',
  rate_limited: 'Příliš mnoho požadavků na Google Disk. Zkuste to prosím za několik minut.',
  invalid: 'Neplatný požadavek.',
  forbidden: 'K této akci nemáte oprávnění.',
} as const;

export function requireGoogle(): GoogleConfig {
  const cfg = googleConfig();
  if (!cfg.enabled) throw new HttpError(503, MSG.not_configured, 'not_configured');
  return cfg;
}

export async function caller(req: Request) {
  return authenticateCaller(req.headers.get('authorization'), 'Propojení s Google vyžaduje připojenou databázi.');
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
export async function getAccessToken(db: SupabaseClient, cfg: GoogleConfig, opts: { cost?: number; force?: boolean } = {}): Promise<{ token: string; expiresAt: number; userId: string }> {
  let row = await readCreds(db, cfg, opts.cost ?? 1);
  if (!row) throw new HttpError(409, MSG.not_connected, 'not_connected');
  if (row.status === 'revoked') throw new HttpError(409, MSG.revoked, 'revoked');
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
    throw new HttpError(503, MSG.unavailable, 'unavailable');
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
      throw new HttpError(503, MSG.unavailable, 'unavailable');
    }
    throw err;
  }
}
