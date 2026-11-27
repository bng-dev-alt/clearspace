import { NextRequest, NextResponse } from 'next/server';
import { dbError, errorResponse, NO_STORE, readJson } from '../../../../lib/google/server';
import { TEST_MESSAGE } from '../../../../lib/notify/message';
import { notifyLog, parseProvider, requireNotify, requireSlack, requireTelegram, rpcRow, sendWith, notifyCaller } from '../../../../lib/notify/server';

const OUTCOME_TEXT: Record<string, string> = {
  sent: 'Zkušební zpráva odeslána.',
  retry: 'Služba je dočasně nedostupná, zprávu se nepodařilo odeslat. Zkuste to prosím později.',
  failed: 'Zprávu se nepodařilo odeslat.',
  reconnect: 'Přístup vypršel nebo byl zrušen. Připojte prosím kanál znovu.',
  blocked: 'Bot je v Telegramu zablokovaný. Odblokujte ho a připojte kanál znovu.',
};

/** POST /api/notify/test { provider } -- a test message to the caller's own channel (at most one per 30 s). */
export async function POST(req: NextRequest) {
  try {
    requireNotify();                                   // the switch first (both off -> 503 before anything else)
    const b = await readJson<{ provider?: unknown }>(req);
    const provider = parseProvider(b.provider);
    const { cfg } = provider === 'slack' ? requireSlack() : requireTelegram();
    const { db } = await notifyCaller(req.headers.get('authorization'));
    const ch = await rpcRow<{ channel_id: string; secret_enc: string }>(db, 'notify_test_begin', { p_server_secret: cfg.serverSecret, p_provider: provider, p_allow_confirm: false })
      .catch((e) => { throw dbError(e); });
    if (!ch) throw dbError({ code: '22023', message: 'Kanál není připojený.' });
    const out = await sendWith(cfg, provider, ch.channel_id, ch.secret_enc, TEST_MESSAGE);
    const mark = out.outcome === 'sent' ? 'sent' : out.outcome === 'reconnect' || out.outcome === 'blocked' ? out.outcome : 'failed';
    await db.rpc('notify_channel_mark', { p_server_secret: cfg.serverSecret, p_provider: provider, p_outcome: mark, p_error_code: out.outcome === 'sent' ? null : out.code });
    notifyLog('test', { provider, outcome: out.outcome, code: 'code' in out ? out.code : null });
    return NextResponse.json({ outcome: out.outcome, message: OUTCOME_TEXT[out.outcome] }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'notify-test');
  }
}
