import { NextRequest, NextResponse } from 'next/server';
import { dbError, errorResponse, NO_STORE } from '../../../../lib/google/server';
import { providerEnabled } from '../../../../lib/notify/config';
import { requireNotify, notifyCaller } from '../../../../lib/notify/server';

/** GET /api/notify/status -- the caller's external notification channels + preferences. 503 when both providers are off. */
export async function GET(req: NextRequest) {
  try {
    const cfg = requireNotify();
    const { db } = await notifyCaller(req.headers.get('authorization'));
    const { data, error } = await db.rpc('notify_status', { p_server_secret: cfg.serverSecret });
    if (error) throw dbError(error);
    const slackOk = providerEnabled('slack') && !('error' in cfg.slack);
    const telegramOk = providerEnabled('telegram') && !('error' in cfg.telegram);
    return NextResponse.json({
      slack: { available: slackOk, simulated: slackOk && 'mock' in cfg.slack && cfg.slack.mock },
      telegram: { available: telegramOk, simulated: telegramOk && 'mock' in cfg.telegram && cfg.telegram.mock },
      ...(data as object),
    }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'notify-status');
  }
}
