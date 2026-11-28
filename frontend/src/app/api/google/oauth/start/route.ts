import { NextRequest, NextResponse } from 'next/server';
import { OAUTH_COOKIE, SERVICE_SCOPES, serviceAllowedFor, serviceAllowedForAccount, type GoogleService } from '../../../../../lib/google/config';
import { pkcePair, randomToken, seal, sha256hex, tokenAad } from '../../../../../lib/google/crypto';
import { buildAuthUrl } from '../../../../../lib/google/oauth';
import { caller, dbError, DISABLED, errorResponse, HttpError, NO_STORE, readJson, requireGoogle } from '../../../../../lib/google/server';

const RETURN_TO = /^\/(settings|projects\/[A-Za-z0-9_-]{1,100})$/;

/**
 * POST /api/google/oauth/start { returnTo, service? } -- begins connecting the caller's Google account, or adding one
 * service to it (RUN 03 incremental authorization: 'drive' (default, RUN 02), 'gmail' or (RUN 04) 'calendar'). Only that service's scope is
 * requested; include_granted_scopes keeps what was granted before. The requested scopes are stored with the state, so
 * the completion knows which service was asked for.
 * The state (single use, 10 min) is bound to this ClearSpace user (authenticated call) and to this browser
 * (HttpOnly cookie nonce, only its hash is stored). The PKCE verifier is stored encrypted, never sent anywhere.
 */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireGoogle();
    const { db, userId } = await caller(req);
    const body = await readJson<{ returnTo?: unknown; service?: unknown }>(req);
    const returnTo = typeof body.returnTo === 'string' && RETURN_TO.test(body.returnTo) ? body.returnTo : '/settings';
    const service: GoogleService | null = body.service === undefined || body.service === 'drive' ? 'drive'
      : body.service === 'gmail' ? 'gmail' : body.service === 'calendar' ? 'calendar' : body.service === 'meetings' ? 'meetings' : null;
    if (!service) throw new HttpError(400, 'Neplatná služba.', 'invalid');
    // off, or (RUN 06) pilot and this user is not in it: the same answer as off -- nothing reveals that a pilot exists
    if (!serviceAllowedFor(service, userId)) throw new HttpError(503, DISABLED[service], `${service}_disabled`);
    const scopes = SERVICE_SCOPES[service];
    // adding a service to an existing connection: pre-select the same Google account on Google's screen
    const { data: st } = await db.rpc('google_connection_status');
    const current = (Array.isArray(st) ? st[0] : st) as { google_email?: string } | undefined;
    // RUN 06 pilot: the already-connected Google account must be a pilot account too (oauth/complete checks the new one)
    if (current?.google_email && !serviceAllowedForAccount(service, userId, current.google_email)) throw new HttpError(503, DISABLED[service], `${service}_disabled`);
    const state = randomToken(32);
    const nonce = randomToken(32);
    const { verifier, challenge } = pkcePair();
    const { error } = await db.rpc('google_oauth_begin', {
      p_server_secret: cfg.serverSecret,
      p_state_sha256: sha256hex(state),
      p_binding_sha256: sha256hex(nonce),
      p_code_verifier_enc: seal(cfg.keys, verifier, tokenAad(state, 'pkce')),
      p_return_to: returnTo,
      p_scopes: scopes,
    });
    if (error) throw dbError(error, 'Připojení se nepodařilo zahájit.');
    const res = NextResponse.json({ url: buildAuthUrl(cfg, { state, codeChallenge: challenge, scopes, loginHint: current?.google_email }) }, { headers: NO_STORE });
    res.cookies.set(OAUTH_COOKIE, nonce, {
      httpOnly: true,
      secure: cfg.appBaseUrl.startsWith('https://'),
      sameSite: 'lax',                // sent on Google's top-level redirect back to the callback
      path: '/api/google/oauth',
      maxAge: 600,
    });
    return res;
  } catch (err) {
    return errorResponse(err, 'google-oauth-start');
  }
}
