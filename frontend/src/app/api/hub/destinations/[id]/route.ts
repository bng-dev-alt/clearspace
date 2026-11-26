import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller } from '../../../../../lib/collab/invitationServer';
import { dbError, errorResponse, NO_STORE, readJson } from '../../../../../lib/google/server';
import { HUB_EVENT_TYPES, hubProviderEnabled, type HubProvider } from '../../../../../lib/hub/config';
import { sendTo, TEST_TEXT } from '../../../../../lib/hub/dispatch';
import { telegramLeave } from '../../../../../lib/hub/providers';
import { HUB_MSG, hubLog, openRef, requireHub, UUID_RE, type TelegramChatRef } from '../../../../../lib/hub/server';

const auth = (req: NextRequest) => authenticateCaller(req.headers.get('authorization'), 'Integrace vyžadují připojenou databázi.');
async function destId(ctx: RouteContext<'/api/hub/destinations/[id]'>) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) throw dbError({ code: '22023', message: HUB_MSG.invalid });
  return id;
}

/**
 * PATCH /api/hub/destinations/:id
 *   { decision: 'confirm' | 'reject' }                         -- a project manager confirms (or rejects) a channel / group bound by code
 *   { notify, interactive, intelligence, intelligenceAck, eventTypes } -- capabilities (Project Intelligence needs intelligenceAck when switched on)
 */
export async function PATCH(req: NextRequest, ctx: RouteContext<'/api/hub/destinations/[id]'>) {
  try {
    const cfg = requireHub();
    const id = await destId(ctx);
    const b = await readJson<{ decision?: unknown; notify?: unknown; interactive?: unknown; intelligence?: unknown; intelligenceAck?: unknown; eventTypes?: unknown; fullIngest?: unknown }>(req);
    const { db } = await auth(req);
    if (b.decision === 'confirm' || b.decision === 'reject') {
      const { data, error } = await db.rpc('hub_destination_decide', { p_server_secret: cfg.serverSecret, p_destination: id, p_accept: b.decision === 'confirm' });
      if (error) throw dbError(error);
      hubLog('destination_decided', { decision: b.decision });
      return NextResponse.json({ status: data }, { headers: NO_STORE });
    }
    const events = Array.isArray(b.eventTypes) ? b.eventTypes : null;
    if (!events || !events.every((e) => (HUB_EVENT_TYPES as readonly unknown[]).includes(e))) throw dbError({ code: '22023', message: 'Neplatné typy událostí.' });
    const { error } = await db.rpc('hub_destination_configure', {
      p_server_secret: cfg.serverSecret, p_destination: id, p_notify: b.notify === true, p_interactive: b.interactive === true,
      p_intelligence: b.intelligence === true, p_intelligence_ack: b.intelligenceAck === true, p_event_types: events, p_full_ingest: b.fullIngest === true,
    });
    if (error) throw dbError(error);
    hubLog('destination_configured', { notify: b.notify === true, interactive: b.interactive === true, intelligence: b.intelligence === true, full: b.fullIngest === true });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'hub-destination');
  }
}

const TEST_OUTCOME: Record<string, string> = {
  sent: 'Zkušební zpráva odeslána.',
  reactivated: 'Zkušební zpráva odeslána – propojení je znovu aktivní.',
  retry: 'Služba je dočasně nedostupná. Zkuste to prosím později.',
  failed: 'Zprávu se nepodařilo odeslat.',
  reconnect: 'Přístup aplikace byl zrušen. Nainstalujte Slack aplikaci znovu.',
  removed_bot: 'Bot není v kanálu / skupině. Přidejte ho zpět a propojte cíl znovu.',
  archived: 'Kanál je archivovaný.',
};

/** POST /api/hub/destinations/:id -- a test message / re-check (manager, max 1 / 30 s). A proven send re-activates a cut-off destination
 *  (bot added back, workspace reinstalled); a dead one is marked accordingly. */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/hub/destinations/[id]'>) {
  try {
    const cfg = requireHub();
    const id = await destId(ctx);
    const { db } = await auth(req);
    const { data, error } = await db.rpc('hub_destination_target', { p_server_secret: cfg.serverSecret, p_destination: id });
    if (error) throw dbError(error);
    const t = data as { provider: HubProvider; status: string; extRefEnc: string; installationId: string | null; installationEnc: string | null; projectName: string };
    if (!hubProviderEnabled(t.provider)) throw dbError({ code: '22023', message: t.provider === 'slack' ? HUB_MSG.slack_disabled : HUB_MSG.telegram_disabled });
    const { result } = await sendTo(cfg, { provider: t.provider, destinationId: id, extRef: t.extRefEnc, installationId: t.installationId, installation: t.installationEnc }, TEST_TEXT(t.projectName));
    let o: string = result.outcome === 'blocked' ? 'removed_bot' : result.outcome;
    if (o === 'sent' && t.status !== 'active') {
      await db.rpc('hub_destination_mark_user', { p_server_secret: cfg.serverSecret, p_destination: id, p_status: 'active', p_error: null });
      o = 'reactivated';
    }
    if (o === 'reconnect' || o === 'removed_bot' || o === 'archived') {
      await db.rpc('hub_destination_mark_user', { p_server_secret: cfg.serverSecret, p_destination: id, p_status: o === 'reconnect' ? 'revoked' : o, p_error: 'code' in result ? result.code : null });
    }
    hubLog('destination_test', { provider: t.provider, outcome: o });
    return NextResponse.json({ outcome: o === 'reactivated' ? 'sent' : o, reactivated: o === 'reactivated', message: TEST_OUTCOME[o] ?? TEST_OUTCOME.failed }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'hub-destination-test');
  }
}

/**
 * DELETE /api/hub/destinations/:id[?purge=1] -- disconnect at once: binding + conversations go, Project Intelligence imports are deleted,
 * task-linked records stay as history unless purge=1. The Telegram bot then leaves the group (best effort); a Slack workspace stays installed
 * (other channels may use it; uninstall it in Slack).
 */
export async function DELETE(req: NextRequest, ctx: RouteContext<'/api/hub/destinations/[id]'>) {
  try {
    const cfg = requireHub();
    const id = await destId(ctx);
    const { db } = await auth(req);
    const purge = req.nextUrl.searchParams.get('purge') === '1';
    const { data, error } = await db.rpc('hub_destination_remove', { p_server_secret: cfg.serverSecret, p_destination: id, p_purge: purge });
    if (error) throw dbError(error);
    const r = data as { removed: boolean; provider?: HubProvider; purgedMessages?: number; extRefEnc?: string; status?: string };
    if (r.removed && r.provider === 'telegram' && r.extRefEnc && hubProviderEnabled('telegram') && !('error' in cfg.telegram) && r.status !== 'removed_bot') {
      try { await telegramLeave(cfg.telegram, openRef<TelegramChatRef>(cfg, 'destination', id, r.extRefEnc).chatId); } catch { /* best effort */ }
    }
    hubLog('destination_removed', { provider: r.provider ?? null, purged: r.purgedMessages ?? 0 });
    return NextResponse.json({ removed: r.removed, purgedMessages: r.purgedMessages ?? 0 }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'hub-destination-remove');
  }
}
