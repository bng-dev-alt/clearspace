import { NextRequest, NextResponse } from 'next/server';
import { notifyConfig, slackFeatureEnabled } from '../../../../../lib/notify/config';
import { SLACK_COOKIE_PATH, SLACK_RESULT_COOKIE } from '../../../../../lib/notify/config';

/**
 * GET /api/notify/slack/callback -- the redirect URI registered at Slack. It arrives WITHOUT a ClearSpace session (the app keeps it in
 * the browser), so it touches neither the database nor Slack: it parks Slack's answer in a short-lived HttpOnly cookie (path-scoped,
 * never in a page URL) and sends the browser to /settings, which completes the flow under the user's session. Redirects only to
 * APP_BASE_URL (no open redirect). Never logged by `next dev` (next.config.ts noRequestLogPaths).
 */
export async function GET(req: NextRequest) {
  const cfg = slackFeatureEnabled() ? notifyConfig() : null;
  const base = cfg && !('error' in cfg) ? cfg.appBaseUrl : null;
  const q = req.nextUrl.searchParams;
  const state = q.get('state') ?? '';
  const code = q.get('code') ?? '';
  const error = q.get('error') ?? '';
  const valid = /^[A-Za-z0-9_-]{40,64}$/.test(state) && (code ? code.length <= 512 && /^[\x21-\x7e]+$/.test(code) : /^[a-z_]{1,64}$/.test(error));
  const res = base
    ? NextResponse.redirect(`${base}/settings?notify=slack`, 303)
    : new NextResponse(null, { status: 303, headers: { Location: '/settings?notify=disabled' } });
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  if (base) {
    res.cookies.set(SLACK_RESULT_COOKIE, valid ? JSON.stringify(code ? { state, code } : { state, error }) : '{}', {
      httpOnly: true, secure: base.startsWith('https://'), sameSite: 'lax', path: SLACK_COOKIE_PATH, maxAge: 300,
    });
  }
  return res;
}
