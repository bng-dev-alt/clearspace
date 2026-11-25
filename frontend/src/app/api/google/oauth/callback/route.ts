import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { googleConfig, OAUTH_COOKIE } from '../../../../../lib/google/config';
import { open, seal, sha256hex, tokenAad } from '../../../../../lib/google/crypto';
import { exchangeCode, GoogleOAuthError, hasDriveScope, parseIdToken, revokeToken } from '../../../../../lib/google/oauth';

type Outcome = 'connected' | 'denied' | 'scope_denied' | 'expired' | 'conflict' | 'error' | 'not_configured';

/**
 * GET /api/google/oauth/callback -- Google's redirect. No ClearSpace session arrives here, so the transaction is
 * identified by the single-use state AND the browser's HttpOnly nonce cookie (CSRF / account-linking protection).
 * Redirects ONLY to APP_BASE_URL + a return path validated when the flow began (no open redirect). Nothing from
 * the token response is logged; the browser never sees a token.
 */
export async function GET(req: NextRequest) {
  const cfg = googleConfig();
  const fallback = (o: Outcome, base?: string) => back(base ?? null, '/settings', o);
  if (!cfg.enabled || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return fallback('not_configured');
  const url = req.nextUrl;
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const oauthError = url.searchParams.get('error');
  const nonce = req.cookies.get(OAUTH_COOKIE)?.value ?? '';
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(state) || !/^[A-Za-z0-9_-]{40,64}$/.test(nonce)) return fallback('expired', cfg.appBaseUrl);

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const stateHash = sha256hex(state);
  const { data, error } = await db.rpc('google_oauth_consume', { p_server_secret: cfg.serverSecret, p_state_sha256: stateHash, p_binding_sha256: sha256hex(nonce) });
  const row = (Array.isArray(data) ? data[0] : data) as { user_id: string; code_verifier_enc: string; return_to: string } | undefined;
  if (error || !row) return fallback('expired', cfg.appBaseUrl);
  const to = (o: Outcome) => back(cfg.appBaseUrl, row.return_to, o);

  if (oauthError) return to(oauthError === 'access_denied' ? 'denied' : 'error');
  if (!code || code.length > 2048) return to('error');
  try {
    const verifier = open(cfg.keys, row.code_verifier_enc, tokenAad(state, 'pkce'));
    const t = await exchangeCode(cfg, code, verifier);
    if (!hasDriveScope(t.scopes)) {
      // the user unticked Drive on Google's consent screen: keep nothing, give the grant back
      await revokeToken(cfg, t.refreshToken ?? t.accessToken);
      await db.rpc('google_oauth_audit_denied', { p_server_secret: cfg.serverSecret, p_state_sha256: stateHash });
      return to('scope_denied');
    }
    const id = parseIdToken(cfg, t.idToken);
    const { error: saveErr } = await db.rpc('google_oauth_complete', {
      p_server_secret: cfg.serverSecret,
      p_state_sha256: stateHash,
      p_sub: id.sub,
      p_email: id.email,
      p_scopes: t.scopes,
      p_refresh_token_enc: t.refreshToken ? seal(cfg.keys, t.refreshToken, tokenAad(row.user_id, 'refresh')) : null,
      p_access_token_enc: seal(cfg.keys, t.accessToken, tokenAad(row.user_id, 'access')),
      p_access_expires_at: new Date(Date.now() + t.expiresIn * 1000).toISOString(),
    });
    if (saveErr) {
      // Same Google account already connected to another ClearSpace account: do NOT revoke -- a revocation at Google
      // ends the app's whole grant for that Google account, i.e. also the other (legitimate) connection.
      if (saveErr.code === '23505') return to('conflict');
      await revokeToken(cfg, t.refreshToken ?? t.accessToken);   // nothing stored: no orphaned live grant
      return to('error');
    }
    return to('connected');
  } catch (err) {
    console.warn('[google-oauth-callback] failed:', err instanceof GoogleOAuthError ? err.code : (err as Error)?.name);
    return to('error');
  }
}

function back(base: string | null, path: string, outcome: Outcome): NextResponse {
  const target = base ? `${base}${path}?google=${outcome}` : `/settings?google=${outcome}`;
  const res = base ? NextResponse.redirect(target, 303) : new NextResponse(null, { status: 303, headers: { Location: target } });
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');   // the callback URL carries the code
  res.cookies.set(OAUTH_COOKIE, '', { path: '/api/google/oauth', maxAge: 0 });
  return res;
}
