import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller, HttpError } from '../../../../../lib/collab/invitationServer';
import { dbError, errorResponse, NO_STORE, readJson } from '../../../../../lib/google/server';
import { MSG, requireTelegram, rpcRow, sendWith } from '../../../../../lib/notify/server';

/**
 * POST /api/notify/telegram/confirm { accept } -- the owner confirms that the found chat is theirs (only then anything is delivered),
 * or rejects it (the link is removed). On accept a first message confirms the connection in Telegram.
 */
export async function POST(req: NextRequest) {
  try {
    const { cfg } = requireTelegram();
    const { db } = await authenticateCaller(req.headers.get('authorization'), 'Oznámení vyžadují připojenou databázi.');
    const b = await readJson<{ accept?: unknown }>(req);
    if (typeof b.accept !== 'boolean') throw new HttpError(400, MSG.invalid, 'invalid');
    const { data, error } = await db.rpc('notify_telegram_confirm', { p_server_secret: cfg.serverSecret, p_accept: b.accept });
    if (error) throw dbError(error);
    if (data === 'active') {
      const ch = await rpcRow<{ channel_id: string; secret_enc: string }>(db, 'notify_test_begin', { p_server_secret: cfg.serverSecret, p_provider: 'telegram', p_allow_confirm: false }).catch(() => null);
      if (ch) {
        const out = await sendWith(cfg, 'telegram', ch.channel_id, ch.secret_enc, 'ClearSpace\nHotovo – oznámení z ClearSpace budou chodit sem.');
        await db.rpc('notify_channel_mark', { p_server_secret: cfg.serverSecret, p_provider: 'telegram', p_outcome: out.outcome === 'sent' ? 'sent' : out.outcome === 'reconnect' || out.outcome === 'blocked' ? out.outcome : 'failed', p_error_code: out.outcome === 'sent' ? null : out.code });
      }
    }
    return NextResponse.json({ status: data }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'notify-telegram-confirm');
  }
}
