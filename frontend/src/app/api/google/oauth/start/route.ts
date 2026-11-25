import { NextRequest, NextResponse } from 'next/server';
import { DRIVE_SCOPES, OAUTH_COOKIE } from '../../../../../lib/google/config';
import { pkcePair, randomToken, seal, sha256hex, tokenAad } from '../../../../../lib/google/crypto';
import { buildAuthUrl } from '../../../../../lib/google/oauth';
import { caller, dbError, errorResponse, NO_STORE, readJson, requireGoogle } from '../../../../../lib/google/server';

const RETURN_TO = /^\/(settings|projects\/[A-Za-z0-9_-]{1,100})$/;

/**
 * POST /api/google/oauth/start { returnTo } -- begins connecting the caller's Google account.
 * The state (single use, 10 min) is bound to this ClearSpace user (authenticated call) and to this browser
 * (HttpOnly cookie nonce, only its hash is stored). The PKCE verifier is stored encrypted, never sent anywhere.
 */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireGoogle();
    const { db } = await caller(req);
    const body = await readJson<{ returnTo?: unknown }>(req);
    const returnTo = typeof body.returnTo === 'string' && RETURN_TO.test(body.returnTo) ? body.returnTo : '/settings';
    const state = randomToken(32);
    const nonce = randomToken(32);
    const { verifier, challenge } = pkcePair();
    const { error } = await db.rpc('google_oauth_begin', {
      p_server_secret: cfg.serverSecret,
      p_state_sha256: sha256hex(state),
      p_binding_sha256: sha256hex(nonce),
      p_code_verifier_enc: seal(cfg.keys, verifier, tokenAad(state, 'pkce')),
      p_return_to: returnTo,
      p_scopes: DRIVE_SCOPES,
    });
    if (error) throw dbError(error, 'Připojení se nepodařilo zahájit.');
    const res = NextResponse.json({ url: buildAuthUrl(cfg, { state, codeChallenge: challenge, scopes: DRIVE_SCOPES }) }, { headers: NO_STORE });
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
