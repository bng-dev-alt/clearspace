import { NextRequest, NextResponse } from 'next/server';
import { GMAIL_READONLY_SCOPE, OAUTH_COOKIE, OAUTH_COOKIE_PATH, OAUTH_RESULT_COOKIE, secretFormat, SERVICE_SCOPE, type GoogleService } from '../../../../../lib/google/config';
import { open, seal, sha256hex, tokenAad } from '../../../../../lib/google/crypto';
import { exchangeCode, GoogleOAuthError, hasDriveScope, hasService, parseIdToken, revokeToken } from '../../../../../lib/google/oauth';
import { caller, errorResponse, NO_STORE, oauthLog, requireGoogle } from '../../../../../lib/google/server';

type Outcome = 'connected' | 'denied' | 'scope_denied' | 'expired' | 'conflict' | 'error' | 'gmail_connected' | 'gmail_denied' | 'account_mismatch' | 'unavailable';

/**
 * POST /api/google/oauth/complete -- finishes connecting a Google account, under the user's ClearSpace session.
 * The transaction must match three bindings: the signed-in user who began it, this browser's HttpOnly nonce cookie,
 * and the single-use, 10-minute state. The code is exchanged server-side with the PKCE verifier and the client
 * secret; tokens are encrypted before they reach the database. Nothing from Google's response is logged or returned.
 */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireGoogle();
    const { db, userId } = await caller(req);
    const nonce = req.cookies.get(OAUTH_COOKIE)?.value ?? '';
    let result: { state?: string; code?: string; error?: string } = {};
    try { result = JSON.parse(req.cookies.get(OAUTH_RESULT_COOKIE)?.value ?? '{}'); } catch { /* malformed */ }
    const reply = (outcome: Outcome, returnTo = '/settings') => {
      oauthLog('complete_result', { outcome });
      const res = NextResponse.json({ outcome, returnTo }, { headers: NO_STORE });
      res.cookies.set(OAUTH_COOKIE, '', { path: OAUTH_COOKIE_PATH, maxAge: 0 });
      res.cookies.set(OAUTH_RESULT_COOKIE, '', { path: OAUTH_COOKIE_PATH, maxAge: 0 });
      return res;
    };
    const state = typeof result.state === 'string' ? result.state : '';
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(state) || !/^[A-Za-z0-9_-]{40,64}$/.test(nonce)) {
      oauthLog('state_rejected', { why: !/^[A-Za-z0-9_-]{40,64}$/.test(state) ? 'no_result_cookie' : 'no_nonce_cookie' });
      return reply('expired');
    }

    const stateHash = sha256hex(state);
    const { data, error } = await db.rpc('google_oauth_consume', { p_server_secret: cfg.serverSecret, p_state_sha256: stateHash, p_binding_sha256: sha256hex(nonce) });
    const row = (Array.isArray(data) ? data[0] : data) as { user_id: string; code_verifier_enc: string; return_to: string; scopes: string[] } | undefined;
    if (error || !row || row.user_id !== userId) {
      oauthLog('state_rejected', { why: error ? 'consume_error' : !row ? 'not_found_used_or_expired' : 'other_user', pgCode: error?.code });
      return reply('expired');
    }
    oauthLog('state_consumed', { hasError: Boolean(result.error), hasCode: Boolean(result.code) });
    if (result.error) return reply(result.error === 'access_denied' ? 'denied' : 'error', row.return_to);
    if (typeof result.code !== 'string' || !result.code) return reply('error', row.return_to);

    // RUN 03: which service did THIS round trip ask for (stored with the state at start; never from the client)
    const service: GoogleService = row.scopes?.includes(GMAIL_READONLY_SCOPE) ? 'gmail' : 'drive';
    try {
      const t = await exchangeCode(cfg, result.code, open(cfg.keys, row.code_verifier_enc, tokenAad(state, 'pkce')));
      const granted = t.scopes.includes(SERVICE_SCOPE[service]);
      oauthLog('exchange_ok', { service, hasRefresh: Boolean(t.refreshToken), hasIdToken: Boolean(t.idToken), driveGranted: hasDriveScope(t.scopes), gmailGranted: hasService(t.scopes, 'gmail'), scopeCount: t.scopes.length, expiresIn: t.expiresIn });
      const id = parseIdToken(cfg, t.idToken);
      oauthLog('identity_ok', { subLength: id.sub.length });
      const { data: subData, error: subErr } = await db.rpc('google_connection_sub', { p_server_secret: cfg.serverSecret, p_candidate_sub: id.sub });
      const sub = (Array.isArray(subData) ? subData[0] : subData) as { own_sub: string | null; candidate_in_use: boolean } | undefined;
      // fail CLOSED: without knowing who else depends on this grant we neither store nor revoke anything
      if (subErr || !sub) { oauthLog('complete_failed', { stage: 'account_lookup', pgCode: subErr?.code }); return reply('error', row.return_to); }
      const existing = sub?.own_sub ?? null;
      // A Google grant is revoked only as a WHOLE (all services, every ClearSpace user of that Google account). So a token
      // we do not keep is revoked only when nothing else depends on that grant.
      const dropUnused = async () => { if (!sub?.candidate_in_use) await revokeToken(cfg, t.refreshToken ?? t.accessToken); };

      if (service === 'gmail' && existing && existing !== id.sub) {
        // Adding Gmail must not silently switch the connected Google account (Drive links / earlier e-mails belong to it).
        oauthLog('account_mismatch', { service });
        await dropUnused();
        return reply('account_mismatch', row.return_to);
      }
      if (!granted) {
        // The user unticked the requested service on Google's (granular) consent screen. An existing connection is left
        // exactly as it was -- revoking here would also end Drive (or Gmail) access granted earlier.
        await db.rpc('google_service_audit', { p_server_secret: cfg.serverSecret, p_event: 'scope_denied', p_service: service });
        if (service === 'drive') await db.rpc('google_oauth_audit_denied', { p_server_secret: cfg.serverSecret, p_state_sha256: stateHash });
        if (!existing) await dropUnused();
        return reply(service === 'gmail' ? 'gmail_denied' : 'scope_denied', row.return_to);
      }
      // Store what ClearSpace uses: identity + the services the user enabled HERE (before, or just now). Google answers with
      // the union of everything ever granted (include_granted_scopes), which may still contain a service the user removed
      // in ClearSpace -- that one stays off until the user enables it again.
      const { data: stData } = await db.rpc('google_connection_status');
      const before = (existing === id.sub ? ((Array.isArray(stData) ? stData[0] : stData) as { scopes?: string[] } | undefined)?.scopes : null) ?? [];
      const keep = t.scopes.filter((sc) => !Object.values(SERVICE_SCOPE).includes(sc) || sc === SERVICE_SCOPE[service] || before.includes(sc));
      const { error: saveErr } = await db.rpc('google_oauth_complete', {
        p_server_secret: cfg.serverSecret,
        p_state_sha256: stateHash,
        p_sub: id.sub,
        p_email: id.email,
        p_scopes: keep,
        p_refresh_token_enc: t.refreshToken ? seal(cfg.keys, t.refreshToken, tokenAad(userId, 'refresh')) : null,
        p_access_token_enc: seal(cfg.keys, t.accessToken, tokenAad(userId, 'access')),
        p_access_expires_at: new Date(Date.now() + t.expiresIn * 1000).toISOString(),
      });
      oauthLog(saveErr ? 'save_failed' : 'saved', { pgCode: saveErr?.code, refreshKept: !t.refreshToken });
      if (saveErr) {
        // Same Google account already connected to another ClearSpace account: do NOT revoke -- a revocation at
        // Google ends the app's whole grant for that Google account, i.e. also the other (legitimate) connection.
        if (saveErr.code === '23505') return reply('conflict', row.return_to);
        await dropUnused();   // nothing stored: no orphaned live grant
        return reply('error', row.return_to);
      }
      if (service === 'gmail') {
        await db.rpc('google_service_audit', { p_server_secret: cfg.serverSecret, p_event: 'service_added', p_service: 'gmail' });
        return reply('gmail_connected', row.return_to);
      }
      return reply('connected', row.return_to);
    } catch (err) {
      oauthLog('complete_failed', { stage: 'exchange_or_identity', code: err instanceof GoogleOAuthError ? err.code : (err as Error)?.name, httpStatus: err instanceof GoogleOAuthError ? err.status : undefined, reason: err instanceof GoogleOAuthError ? err.reason : undefined, mode: cfg.mock ? 'mock' : 'real', secretFormat: secretFormat(cfg.clientSecret) });
      // Google did not answer (timeout / network): nothing was stored or revoked. The authorization code is single-use and may
      // already have been redeemed at Google, so it is NEVER replayed automatically -- the user simply connects again.
      return reply(err instanceof GoogleOAuthError && err.code === 'unavailable' ? 'unavailable' : 'error', row.return_to);
    }
  } catch (err) {
    return errorResponse(err, 'google-oauth-complete');
  }
}
