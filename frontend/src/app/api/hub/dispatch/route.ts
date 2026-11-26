import { NextRequest, NextResponse } from 'next/server';
import { isProductionRuntime } from '../../../../lib/email/config';
import { NO_STORE } from '../../../../lib/google/server';
import { hubAnyEnabled, hubConfig } from '../../../../lib/hub/config';
import { parseHubItem, sendHubBatch, type HubItem, type HubResult } from '../../../../lib/hub/dispatch';
import { hubLog, verifyScheduler } from '../../../../lib/hub/server';

export const maxDuration = 60;

/**
 * POST /api/hub/dispatch -- called ONLY by the database scheduler (public.hub_scheduler_tick via pg_net) with x-hub-secret. Body
 * { items } (already re-checked by the database). Answers one outcome per item; the database applies them on its next tick. 503 when
 * the hub is off (the database cancels that batch). No user session, no database access here.
 */
export async function POST(req: NextRequest) {
  if (!hubAnyEnabled()) return NextResponse.json({ error: 'hub_disabled' }, { status: 503, headers: NO_STORE });
  const cfg = hubConfig();
  if ('error' in cfg) return NextResponse.json({ error: 'not_configured' }, { status: 503, headers: NO_STORE });
  if (!verifyScheduler(cfg.serverSecret, req.headers)) {
    hubLog('dispatch_unauthorized');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }
  const text = await req.text();
  if (text.length > 512 * 1024) return NextResponse.json({ error: 'too_large' }, { status: 413, headers: NO_STORE });
  let body: { items?: unknown; now?: unknown };
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: 'invalid' }, { status: 400, headers: NO_STORE }); }
  const raw = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
  const results: HubResult[] = [];
  const items: HubItem[] = [];
  for (const r of raw) {
    const it = parseHubItem(r);
    if (it) items.push(it);
    else if (typeof (r as { id?: unknown })?.id === 'string') results.push({ id: (r as { id: string }).id, outcome: 'failed', code: 'invalid_item' });
  }
  const now = !isProductionRuntime(process.env) && typeof body.now === 'string' && !Number.isNaN(Date.parse(body.now)) ? new Date(body.now) : new Date();
  results.push(...await sendHubBatch(cfg, items, now));
  const count = (o: string) => results.filter((x) => x.outcome === o).length;
  hubLog('dispatch', { items: raw.length, sent: count('sent'), retry: count('retry'), failed: count('failed'), release: count('release'), cancelled: count('cancelled'),
    revoked: count('reconnect'), removed: count('removed_bot'), archived: count('archived') });
  return NextResponse.json({ results }, { headers: NO_STORE });
}
