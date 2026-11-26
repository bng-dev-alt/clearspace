import { after, NextRequest, NextResponse } from 'next/server';
import { HttpError } from '../../../../../lib/collab/invitationServer';
import { processInbox, receive } from '../../../../../lib/hub/inbound';
import { hubLog, readRaw, requireHubTelegram, serviceDb, verifyTelegram } from '../../../../../lib/hub/server';

export const maxDuration = 30;

/**
 * POST /api/hub/telegram/webhook -- updates of the PROJECT bot (official Bot API webhook, secret header). Privacy mode stays ON: in groups
 * the bot receives only commands addressed to it, replies to its own messages and service messages. The update is RECORDED durably
 * (update_id dedupe) and processed after the response (src/lib/hub/inbound.ts): retries are bounded, replies are never sent twice.
 */
export async function POST(req: NextRequest) {
  try {
    const { cfg, telegram } = requireHubTelegram();
    if (!verifyTelegram(telegram.webhookSecret, req.headers)) { hubLog('telegram_bad_secret'); return new NextResponse(null, { status: 401 }); }
    let u: Record<string, unknown>;
    try { u = JSON.parse(await readRaw(req)); } catch (e) { if (e instanceof HttpError) throw e; return new NextResponse(null, { status: 400 }); }
    if (!Number.isSafeInteger(u.update_id)) return new NextResponse(null, { status: 200 });
    const db = await serviceDb(cfg);
    const r = await receive({ cfg, db }, 'telegram', `u:${u.update_id}`, { src: 'telegram', body: u });
    if (!r.process) { hubLog('telegram_update_duplicate'); return new NextResponse(null, { status: 200 }); }
    after(() => processInbox({ cfg, db }, r.id).catch(() => hubLog('inbound_process_error')));
    return new NextResponse(null, { status: 200 });
  } catch (err) {
    hubLog('telegram_webhook_error', { code: err instanceof HttpError ? err.code : 'error' });
    if (err instanceof HttpError && (err.status === 503 || err.status === 413)) return NextResponse.json({ error: err.code }, { status: err.status });
    return new NextResponse(null, { status: 500 });     // not recorded -> Telegram delivers it again
  }
}
