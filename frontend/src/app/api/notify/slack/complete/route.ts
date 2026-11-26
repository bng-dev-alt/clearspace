import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller } from '../../../../../lib/collab/invitationServer';
import { seal, sha256hex } from '../../../../../lib/google/crypto';
import { dbError, errorResponse, NO_STORE } from '../../../../../lib/google/server';
import { channelAad, teamHmac } from '../../../../../lib/notify/config';
import { clean } from '../../../../../lib/notify/message';
import { slackExchange, slackRevoke } from '../../../../../lib/notify/providers';
import { notifyLog, openSecret, requireSlack, rpcRow } from '../../../../../lib/notify/server';
import { SLACK_COOKIE_PATH, SLACK_NONCE_COOKIE, SLACK_RESULT_COOKIE } from '../../../../../lib/notify/config';

/**
 * POST /api/notify/slack/complete -- finishes the Slack connection under the user's session: Slack's parked answer (cookie) + this
 * browser's nonce must match a state THIS user began; the code is exchanged server-side; the bot token + the connecting user's Slack id
 * are stored encrypted. Outcome: connected | denied | expired | unsupported | error | unavailable.
 */
export async function POST(req: NextRequest) {
  const done = (outcome: string, status = 200) => {
    const res = NextResponse.json({ outcome }, { status, headers: NO_STORE });
    for (const c of [SLACK_RESULT_COOKIE, SLACK_NONCE_COOKIE]) res.cookies.set(c, '', { httpOnly: true, path: SLACK_COOKIE_PATH, maxAge: 0 });
    return res;
  };
  try {
    const { cfg, slack } = requireSlack();
    const { db } = await authenticateCaller(req.headers.get('authorization'), 'Oznámení vyžadují připojenou databázi.');
    let parked: { state?: string; code?: string; error?: string } = {};
    try { parked = JSON.parse(req.cookies.get(SLACK_RESULT_COOKIE)?.value ?? '{}'); } catch { /* empty */ }
    const nonce = req.cookies.get(SLACK_NONCE_COOKIE)?.value ?? '';
    if (!parked.state || !nonce) return done('expired');
    if (parked.error) { notifyLog('slack_denied', { error: parked.error }); return done('denied'); }
    const hash = sha256hex(`${parked.state}.${nonce}`);
    const channelId = await rpcRow<string>(db, 'notify_slack_lookup', { p_server_secret: cfg.serverSecret, p_link_hash: hash }).catch((e) => { throw dbError(e); });
    if (!channelId || typeof channelId !== 'string') return done('expired');
    const ex = await slackExchange(slack, parked.code ?? '');
    if (!ex.ok) { notifyLog('slack_exchange_refused', { reason: ex.reason }); return done(ex.reason); }
    const env = seal(cfg.keys, JSON.stringify({ botToken: ex.grant.botToken, userId: ex.grant.userId }), channelAad('slack', channelId));
    const old = await rpcRow<{ old_secret_enc: string | null; old_team_shared: number }>(db, 'notify_slack_complete', {
      p_server_secret: cfg.serverSecret, p_link_hash: hash, p_secret_enc: env, p_team_hmac: teamHmac(cfg.serverSecret, ex.grant.teamId),
      p_label: clean(ex.grant.teamName, 100) || 'Slack',
    }).catch((e) => { throw dbError(e); });
    if (old?.old_secret_enc && old.old_team_shared === 0) {
      try { await slackRevoke(slack, openSecret(cfg, 'slack', channelId, old.old_secret_enc).botToken); } catch { /* best effort */ }
    }
    notifyLog('slack_connected', { mock: slack.mock });
    return done('connected');
  } catch (err) {
    return errorResponse(err, 'notify-slack-complete');
  }
}
