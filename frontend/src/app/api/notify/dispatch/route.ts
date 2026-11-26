import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE } from '../../../../lib/google/server';
import { anyNotifyEnabled, notifyConfig } from '../../../../lib/notify/config';
import { isProductionRuntime } from '../../../../lib/email/config';
import { notifyLog, parseItem, schedulerAuthorized, sendBatch } from '../../../../lib/notify/server';

export const maxDuration = 60;

/**
 * POST /api/notify/dispatch -- called ONLY by the database scheduler (public.notify_scheduler_tick via pg_net) with the x-notify-secret
 * header. Body: { items: [...] } (already re-checked by the database). Decrypts each channel credential, sends, answers one outcome per
 * item; the database records them on its next tick. 503 when both providers are off (the database drops that batch). No user session,
 * no database access here.
 */
export async function POST(req: NextRequest) {
  if (!anyNotifyEnabled()) return NextResponse.json({ error: 'notify_disabled' }, { status: 503, headers: NO_STORE });
  const cfg = notifyConfig();
  if ('error' in cfg) return NextResponse.json({ error: 'not_configured' }, { status: 503, headers: NO_STORE });
  if (!schedulerAuthorized(req.headers.get('x-notify-secret'), cfg)) {
    notifyLog('dispatch_unauthorized');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }
  const text = await req.text();
  if (text.length > 512 * 1024) return NextResponse.json({ error: 'too_large' }, { status: 413, headers: NO_STORE });
  let body: { items?: unknown; now?: unknown };
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: 'invalid' }, { status: 400, headers: NO_STORE }); }
  const raw = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
  const results: Array<{ id: string; outcome: string; code?: string; retryAfter?: number }> = [];
  const items = [];
  for (const r of raw) {
    const it = parseItem(r);
    if (it) items.push(it);
    else if (typeof (r as { id?: unknown })?.id === 'string') results.push({ id: (r as { id: string }).id, outcome: 'failed', code: 'invalid_item' });
  }
  // test clock (local stacks only): the scheduler passes the same `now` it used for due-date reminders, so "Dnes/Zítra" match
  const now = !isProductionRuntime(process.env) && typeof body.now === 'string' && !Number.isNaN(Date.parse(body.now)) ? new Date(body.now) : new Date();
  results.push(...await sendBatch(cfg, items, now));
  const count = (o: string) => results.filter((r) => r.outcome === o).length;
  notifyLog('dispatch', { items: raw.length, sent: count('sent'), retry: count('retry'), failed: count('failed'), release: count('release'), cancelled: count('cancelled'), reconnect: count('reconnect'), blocked: count('blocked') });
  return NextResponse.json({ results }, { headers: NO_STORE });
}
