import { NextRequest, NextResponse } from 'next/server';
import { googleConfig, OAUTH_COOKIE_PATH, OAUTH_RESULT_COOKIE } from '../../../../../lib/google/config';

/**
 * GET /api/google/oauth/callback -- the redirect URI registered at Google. It arrives WITHOUT a ClearSpace session
 * (the app keeps its session in the browser), so it does nothing with the database or Google: it parks Google's
 * answer in a short-lived HttpOnly cookie (path-scoped to the OAuth routes, never in a page URL) and sends the
 * browser to /oauth/google, which completes the flow under the user's session (POST /api/google/oauth/complete).
 * Redirects only to APP_BASE_URL (no open redirect).
 */
export async function GET(req: NextRequest) {
  const cfg = googleConfig();
  const base = cfg.enabled ? cfg.appBaseUrl : null;
  const q = req.nextUrl.searchParams;
  const state = q.get('state') ?? '';
  const code = q.get('code') ?? '';
  const error = q.get('error') ?? '';
  const valid = /^[A-Za-z0-9_-]{40,64}$/.test(state) && (code ? code.length <= 2048 && /^[\x21-\x7e]+$/.test(code) : /^[a-z_]{1,64}$/.test(error));
  const res = base
    ? NextResponse.redirect(`${base}/oauth/google`, 303)
    : new NextResponse(null, { status: 303, headers: { Location: '/settings?google=not_configured' } });
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');   // this URL carries the code
  if (base) {
    res.cookies.set(OAUTH_RESULT_COOKIE, valid ? JSON.stringify(code ? { state, code } : { state, error }) : '{}', {
      httpOnly: true, secure: base.startsWith('https://'), sameSite: 'lax', path: OAUTH_COOKIE_PATH, maxAge: 300,
    });
  }
  return res;
}
