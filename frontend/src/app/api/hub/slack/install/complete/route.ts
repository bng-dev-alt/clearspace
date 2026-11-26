import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller } from '../../../../../../lib/collab/invitationServer';
import { sha256hex } from '../../../../../../lib/google/crypto';
import { dbError, errorResponse, NO_STORE } from '../../../../../../lib/google/server';
import { HUB_INSTALL_COOKIE, HUB_INSTALL_COOKIE_PATH, HUB_INSTALL_RESULT_COOKIE, hubKey } from '../../../../../../lib/hub/config';
import { clean } from '../../../../../../lib/notify/message';
import { slackHubExchange } from '../../../../../../lib/hub/providers';
import { hubLog, requireHubSlack, sealRef } from '../../../../../../lib/hub/server';

/**
 * POST /api/hub/slack/install/complete -- finishes the workspace install under the user's session: parked answer + this browser's nonce must
 * match a state THIS user began; the code is exchanged server-side; the bot token is stored sealed for the installation id.
 * Outcome: installed | denied | expired | unsupported | scope | error | unavailable.
 */
export async function POST(req: NextRequest) {
  const done = (outcome: string) => {
    const res = NextResponse.json({ outcome }, { headers: NO_STORE });
    for (const c of [HUB_INSTALL_RESULT_COOKIE, HUB_INSTALL_COOKIE]) res.cookies.set(c, '', { httpOnly: true, path: HUB_INSTALL_COOKIE_PATH, maxAge: 0 });
    return res;
  };
  try {
    const { cfg, slack } = requireHubSlack();
    const { db } = await authenticateCaller(req.headers.get('authorization'), 'Integrace vyžadují připojenou databázi.');
    let parked: { state?: string; code?: string; error?: string } = {};
    try { parked = JSON.parse(req.cookies.get(HUB_INSTALL_RESULT_COOKIE)?.value ?? '{}'); } catch { /* empty */ }
    const nonce = req.cookies.get(HUB_INSTALL_COOKIE)?.value ?? '';
    if (!parked.state || !nonce) return done('expired');
    if (parked.error) { hubLog('slack_install_denied', { error: parked.error }); return done('denied'); }
    const ex = await slackHubExchange(slack, parked.code ?? '');
    if (!ex.ok) { hubLog('slack_install_refused', { reason: ex.reason }); return done(ex.reason); }
    const teamHmac = hubKey(cfg.serverSecret, 'slack', 'team', ex.grant.teamId);
    const { data: installation, error } = await db.rpc('hub_slack_install_lookup', { p_server_secret: cfg.serverSecret, p_state_hash: sha256hex(`${parked.state}.${nonce}`), p_team_hmac: teamHmac });
    if (error) throw dbError(error);
    if (typeof installation !== 'string') return done('expired');
    const env = sealRef(cfg, 'installation', installation, { botToken: ex.grant.botToken, botUserId: ex.grant.botUserId, appId: ex.grant.appId });
    const { error: e2 } = await db.rpc('hub_slack_install_store', {
      p_server_secret: cfg.serverSecret, p_installation: installation, p_team_hmac: teamHmac, p_team_label: clean(ex.grant.teamName, 100) || 'Slack',
      p_secret_enc: env, p_scopes: ex.grant.scopes,
    });
    if (e2) throw dbError(e2);
    hubLog('slack_installed', { mock: slack.mock });
    return done('installed');
  } catch (err) {
    return errorResponse(err, 'hub-slack-install-complete');
  }
}
