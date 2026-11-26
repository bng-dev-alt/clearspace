import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller } from '../../../../../lib/collab/invitationServer';
import { randomToken, sha256hex } from '../../../../../lib/google/crypto';
import { dbError, errorResponse, NO_STORE } from '../../../../../lib/google/server';
import { slackAuthorizeUrl } from '../../../../../lib/notify/providers';
import { requireSlack } from '../../../../../lib/notify/server';
import { SLACK_COOKIE_PATH, SLACK_NONCE_COOKIE } from '../../../../../lib/notify/config';


/**
 * POST /api/notify/slack/start -- begins connecting Slack (OAuth v2, bot scope chat:write only). The state (single use, 10 min) is bound to
 * this ClearSpace user (authenticated call) AND this browser (HttpOnly nonce cookie): only SHA-256(state.nonce) is stored.
 */
export async function POST(req: NextRequest) {
  try {
    const { cfg, slack } = requireSlack();
    const { db } = await authenticateCaller(req.headers.get('authorization'), 'Oznámení vyžadují připojenou databázi.');
    const state = randomToken(32);
    const nonce = randomToken(32);
    const { error } = await db.rpc('notify_link_begin', { p_server_secret: cfg.serverSecret, p_provider: 'slack', p_link_hash: sha256hex(`${state}.${nonce}`) });
    if (error) throw dbError(error, 'Připojení se nepodařilo zahájit.');
    const res = NextResponse.json({ url: slackAuthorizeUrl(slack, state) }, { headers: NO_STORE });
    res.cookies.set(SLACK_NONCE_COOKIE, nonce, { httpOnly: true, secure: cfg.appBaseUrl.startsWith('https://'), sameSite: 'lax', path: SLACK_COOKIE_PATH, maxAge: 600 });
    return res;
  } catch (err) {
    return errorResponse(err, 'notify-slack-start');
  }
}
