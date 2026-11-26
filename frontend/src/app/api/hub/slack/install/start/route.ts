import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller } from '../../../../../../lib/collab/invitationServer';
import { randomToken, sha256hex } from '../../../../../../lib/google/crypto';
import { dbError, errorResponse, NO_STORE } from '../../../../../../lib/google/server';
import { HUB_INSTALL_COOKIE, HUB_INSTALL_COOKIE_PATH } from '../../../../../../lib/hub/config';
import { slackHubAuthorizeUrl } from '../../../../../../lib/hub/providers';
import { requireHubSlack } from '../../../../../../lib/hub/server';

/**
 * POST /api/hub/slack/install/start -- install the PROJECT Slack app into a workspace (OAuth v2, bot scopes chat:write, commands,
 * channels:history, groups:history). Only owners / admins of at least one project. State bound to this user + this browser (nonce cookie).
 */
export async function POST(req: NextRequest) {
  try {
    const { cfg, slack } = requireHubSlack();
    const { db } = await authenticateCaller(req.headers.get('authorization'), 'Integrace vyžadují připojenou databázi.');
    const state = randomToken(32), nonce = randomToken(32);
    const { error } = await db.rpc('hub_slack_install_begin', { p_server_secret: cfg.serverSecret, p_state_hash: sha256hex(`${state}.${nonce}`) });
    if (error) throw dbError(error, 'Instalaci se nepodařilo zahájit.');
    const res = NextResponse.json({ url: slackHubAuthorizeUrl(slack, state) }, { headers: NO_STORE });
    res.cookies.set(HUB_INSTALL_COOKIE, nonce, { httpOnly: true, secure: cfg.appBaseUrl.startsWith('https://'), sameSite: 'lax', path: HUB_INSTALL_COOKIE_PATH, maxAge: 600 });
    return res;
  } catch (err) {
    return errorResponse(err, 'hub-slack-install-start');
  }
}
