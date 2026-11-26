import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller } from '../../../../../lib/collab/invitationServer';
import { seal, sha256hex } from '../../../../../lib/google/crypto';
import { dbError, errorResponse, NO_STORE } from '../../../../../lib/google/server';
import { channelAad } from '../../../../../lib/notify/config';
import { clean, TELEGRAM_CONFIRM_MESSAGE, TELEGRAM_HELP_MESSAGE } from '../../../../../lib/notify/message';
import { telegramSend, telegramStarts } from '../../../../../lib/notify/providers';
import { MSG, notifyLog, requireTelegram, rpcRow } from '../../../../../lib/notify/server';
import { HttpError } from '../../../../../lib/collab/invitationServer';

/**
 * POST /api/notify/telegram/check -- reads the bot's pending /start messages (getUpdates, no webhook) and attaches each valid token's
 * private chat to ITS channel (whoever's request processes it), which then waits for the owner's confirmation in ClearSpace.
 * Everything else sent to the bot is ignored (a bare /start gets a fixed help text). Returns the caller's own Telegram state.
 */
export async function POST(req: NextRequest) {
  try {
    const { cfg, telegram } = requireTelegram();
    const { db } = await authenticateCaller(req.headers.get('authorization'), 'Oznámení vyžadují připojenou databázi.');
    const r = await telegramStarts(telegram);
    if (!r.ok) throw new HttpError(503, MSG.unavailable, 'unavailable');
    let attached = 0;
    for (const s of r.starts) {
      const hash = s.token ? sha256hex(s.token) : null;
      const channelId = hash ? await rpcRow<string>(db, 'notify_telegram_lookup', { p_server_secret: cfg.serverSecret, p_link_hash: hash }).catch((e) => { throw dbError(e); }) : null;
      if (!channelId) { await telegramSend(telegram, s.chatId, TELEGRAM_HELP_MESSAGE); continue; }
      const env = seal(cfg.keys, JSON.stringify({ chatId: s.chatId }), channelAad('telegram', channelId));
      const ok = await rpcRow<string>(db, 'notify_telegram_attach', { p_server_secret: cfg.serverSecret, p_link_hash: hash, p_secret_enc: env, p_label: clean(s.label, 100) || 'Telegram' })
        .catch((e) => { throw dbError(e); });
      if (ok) { attached += 1; await telegramSend(telegram, s.chatId, TELEGRAM_CONFIRM_MESSAGE); }
    }
    notifyLog('telegram_check', { updates: r.starts.length, attached });
    const { data, error } = await db.rpc('notify_status', { p_server_secret: cfg.serverSecret });
    if (error) throw dbError(error);
    const own = ((data as { channels?: Array<{ provider: string }> })?.channels ?? []).find((c) => c.provider === 'telegram') ?? null;
    return NextResponse.json({ channel: own }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'notify-telegram-check');
  }
}
