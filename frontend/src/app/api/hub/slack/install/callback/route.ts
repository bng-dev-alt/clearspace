import { NextRequest, NextResponse } from 'next/server';
import { HUB_INSTALL_COOKIE_PATH, HUB_INSTALL_RESULT_COOKIE, hubConfig, hubSlackEnabled } from '../../../../../../lib/hub/config';

/**
 * GET /api/hub/slack/install/callback -- the redirect URI of the project app. No ClearSpace session here (it lives in the browser): parks
 * Slack's answer in a short-lived HttpOnly cookie and sends the browser to /settings, which completes under the user's session. Redirects
 * only to APP_BASE_URL. Never request-logged (next.config.ts noRequestLogPaths).
 */
export async function GET(req: NextRequest) {
  const cfg = hubSlackEnabled() ? hubConfig() : null;
  const base = cfg && !('error' in cfg) ? cfg.appBaseUrl : null;
  const q = req.nextUrl.searchParams;
  const state = q.get('state') ?? '', code = q.get('code') ?? '', error = q.get('error') ?? '';
  const valid = /^[A-Za-z0-9_-]{40,64}$/.test(state) && (code ? code.length <= 512 && /^[\x21-\x7e]+$/.test(code) : /^[a-z_]{1,64}$/.test(error));
  const res = base ? NextResponse.redirect(`${base}/settings?hub=slack`, 303) : new NextResponse(null, { status: 303, headers: { Location: '/settings?hub=disabled' } });
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  if (base) {
    res.cookies.set(HUB_INSTALL_RESULT_COOKIE, valid ? JSON.stringify(code ? { state, code } : { state, error }) : '{}', {
      httpOnly: true, secure: base.startsWith('https://'), sameSite: 'lax', path: HUB_INSTALL_COOKIE_PATH, maxAge: 300,
    });
  }
  return res;
}
