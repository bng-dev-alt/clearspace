import { after, NextRequest, NextResponse } from 'next/server';
import { HttpError } from '../../../../../lib/collab/invitationServer';
import { processInbox, receive } from '../../../../../lib/hub/inbound';
import { hubLog, readRaw, requireHubTelegram, serviceDb, verifyTelegram } from '../../../../../lib/hub/server';

export const maxDuration = 30;

/**
 * POST /api/hub/telegram/pi-webhook -- the OPTIONAL Project Intelligence bot (privacy mode OFF, never posts). It reads only groups that are
 * confirmed project destinations with Project Intelligence AND full-group ingestion switched on by a manager; everything else is
 * dropped without storage. 503 when no PI bot is configured.
 */
export async function POST(req: NextRequest) {
  try {
    const { cfg, telegram } = requireHubTelegram();
    if (!telegram.pi) return NextResponse.json({ error: 'hub_pi_bot_not_configured' }, { status: 503 });
    if (!verifyTelegram(telegram.pi.webhookSecret, req.headers)) { hubLog('telegram_pi_bad_secret'); return new NextResponse(null, { status: 401 }); }
    let u: Record<string, unknown>;
    try { u = JSON.parse(await readRaw(req)); } catch (e) { if (e instanceof HttpError) throw e; return new NextResponse(null, { status: 400 }); }
    if (!Number.isSafeInteger(u.update_id)) return new NextResponse(null, { status: 200 });
    if (!u.message && !u.edited_message) return new NextResponse(null, { status: 200 });     // nothing else is ever recorded
    const db = await serviceDb(cfg);
    const r = await receive({ cfg, db }, 'telegram', `p:${u.update_id}`, { src: 'telegram_pi', body: u });
    if (r.process) after(() => processInbox({ cfg, db }, r.id).catch(() => hubLog('inbound_process_error')));
    return new NextResponse(null, { status: 200 });
  } catch (err) {
    hubLog('telegram_pi_webhook_error', { code: err instanceof HttpError ? err.code : 'error' });
    if (err instanceof HttpError && (err.status === 503 || err.status === 413)) return NextResponse.json({ error: err.code }, { status: err.status });
    return new NextResponse(null, { status: 500 });
  }
}
