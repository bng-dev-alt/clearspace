import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller } from '../../../../../lib/collab/invitationServer';
import { randomToken, sha256hex } from '../../../../../lib/google/crypto';
import { dbError, errorResponse, NO_STORE } from '../../../../../lib/google/server';
import { requireTelegram } from '../../../../../lib/notify/server';

/** POST /api/notify/telegram/link -- a single-use deep link (10 min) to the bot; only SHA-256 of the token is stored. */
export async function POST(req: NextRequest) {
  try {
    const { cfg, telegram } = requireTelegram();
    const { db } = await authenticateCaller(req.headers.get('authorization'), 'Oznámení vyžadují připojenou databázi.');
    const token = randomToken(32);
    const { error } = await db.rpc('notify_link_begin', { p_server_secret: cfg.serverSecret, p_provider: 'telegram', p_link_hash: sha256hex(token) });
    if (error) throw dbError(error, 'Připojení se nepodařilo zahájit.');
    return NextResponse.json({ url: `https://t.me/${telegram.botUsername}?start=${token}`, expiresInSeconds: 600 }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'notify-telegram-link');
  }
}
