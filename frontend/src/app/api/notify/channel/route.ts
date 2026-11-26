import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller, HttpError } from '../../../../lib/collab/invitationServer';
import { dbError, errorResponse, NO_STORE, readJson } from '../../../../lib/google/server';
import { notifyConfig } from '../../../../lib/notify/config';
import { TELEGRAM_BYE_MESSAGE } from '../../../../lib/notify/message';
import { slackRevoke } from '../../../../lib/notify/providers';
import { MSG, notifyLog, openSecret, parseProvider, requireNotify, rpcRow, sendWith } from '../../../../lib/notify/server';

const who = (req: NextRequest) => authenticateCaller(req.headers.get('authorization'), 'Oznámení vyžadují připojenou databázi.');

/** POST /api/notify/channel { provider, enabled } -- pause / resume the caller's own channel (pausing drops what is queued). */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireNotify();
    const { db } = await who(req);
    const b = await readJson<{ provider?: unknown; enabled?: unknown }>(req);
    const provider = parseProvider(b.provider);
    if (typeof b.enabled !== 'boolean') throw new HttpError(400, MSG.invalid, 'invalid');
    const { data, error } = await db.rpc('notify_channel_set_enabled', { p_server_secret: cfg.serverSecret, p_provider: provider, p_enabled: b.enabled });
    if (error) throw dbError(error);
    return NextResponse.json({ changed: Boolean(data) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'notify-channel');
  }
}

/**
 * DELETE /api/notify/channel?provider=slack|telegram -- disconnect. The channel and its queue are deleted; Slack: the bot token is revoked
 * unless another active ClearSpace user of the same Slack workspace still uses it; Telegram: a last "disconnected" message (best effort).
 * Works while a provider switch is off (users can always remove their data), but needs the server configuration.
 */
export async function DELETE(req: NextRequest) {
  try {
    const cfg = notifyConfig();
    if ('error' in cfg) throw new HttpError(503, MSG.not_configured, 'not_configured');
    const { db } = await who(req);
    const provider = parseProvider(req.nextUrl.searchParams.get('provider'));
    const row = await rpcRow<{ secret_enc: string | null; team_shared: number; channel_id: string | null; status: string }>(db, 'notify_channel_remove', { p_server_secret: cfg.serverSecret, p_provider: provider })
      .catch((e) => { throw dbError(e); });
    if (!row?.channel_id) return NextResponse.json({ removed: false }, { headers: NO_STORE });
    let revoked: boolean | null = null;
    if (row.secret_enc && provider === 'slack' && !('error' in cfg.slack)) {
      if (row.team_shared === 0) {
        try { revoked = await slackRevoke(cfg.slack, openSecret(cfg, 'slack', row.channel_id, row.secret_enc).botToken); } catch { revoked = false; }
      }
    } else if (row.secret_enc && provider === 'telegram' && row.status === 'active') {
      await sendWith(cfg, 'telegram', row.channel_id, row.secret_enc, TELEGRAM_BYE_MESSAGE);
    }
    notifyLog('disconnected', { provider, revoked });
    return NextResponse.json({ removed: true, revoked, shared: row.team_shared > 0 }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'notify-disconnect');
  }
}
