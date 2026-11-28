import { NextRequest, NextResponse } from 'next/server';
import { AiGatewayError } from '../../../../../lib/ai/errors';
import { authenticate, errorResponse, readJsonBody, requireProjectId } from '../../../../../lib/ai/gateway';
import { policyFor } from '../../../../../lib/ai/policy';
import { sttEnabled, sttServerSecret, toGatewayError } from '../../../../../lib/stt/pipeline';
import { SonioxClient, SonioxError, sonioxConfigFromEnv } from '../../../../../lib/stt/soniox';
import { inLivePilot, liveAppend, liveClose, liveComplete, liveConfigFromEnv, liveDiscard, liveStart, type LiveCtx } from '../../../../../lib/stt/live';

/**
 * POST /api/intelligence/meetings/live { projectId, meetingId, action: start|append|close|complete|discard, ... } (RUN 10).
 * Pořadí bran: STT_ENABLED + MEETING_LIVE_ENABLED -> JWT + AI tier -> pilot MEETING_PILOT_USER_IDS -> STT povolené tierem ->
 * DB (člen, organizátor, souhlas, rozpočet). Všechny brány selžou PŘED jakýmkoli voláním poskytovatele. complete/discard/close
 * fungují i po vypnutí přepisu (ukončení a uložení nesmí blokovat vypínač), ale nikdy nevydají nový klíč.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['start', 'append', 'close', 'complete', 'discard']);
const posInt = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : null);

export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody(req, 300_000);
    const action = typeof body.action === 'string' && ACTIONS.has(body.action) ? body.action : null;
    if (!action) throw new AiGatewayError('bad_request', 'Neplatná akce.');
    const cfg = liveConfigFromEnv();
    const opening = action === 'start' || action === 'append';
    if (opening && (!sttEnabled() || !cfg.enabled)) throw new AiGatewayError('stt_disabled', 'Živý přepis je v této instalaci vypnutý.');
    const auth = await authenticate(req);
    if (!inLivePilot(cfg, auth.user.id)) throw new AiGatewayError('forbidden', 'Živý přepis porad je zatím jen v pilotním provozu.');
    const policy = policyFor(auth.tier ?? 'dev');
    if (opening && !policy.stt.allowed) throw new AiGatewayError('forbidden', 'Přepis zvuku není pro tento účet dostupný.');
    requireProjectId(body);
    const meetingId = typeof body.meetingId === 'string' && UUID.test(body.meetingId) ? body.meetingId.toLowerCase() : null;
    if (!meetingId) throw new AiGatewayError('bad_request', 'Neplatný identifikátor porady.');
    const ctx: LiveCtx = {
      db: auth.db,
      soniox: action === 'start' ? new SonioxClient(sonioxConfigFromEnv()) : null,
      secret: sttServerSecret(),
      meetingId,
      userDailyMs: policy.stt.userDailyMs,
      globalDailyMs: policy.stt.globalDailyMs,
      cfg,
    };
    let out: Record<string, unknown>;
    if (action === 'start') out = await liveStart(ctx);
    else if (action === 'append') {
      const segment = posInt(body.segment, 200);
      const seq = posInt(body.seq, 100_000);
      if (!segment || !seq) throw new AiGatewayError('bad_request', 'Neplatná část přepisu.');
      out = await liveAppend(ctx, { segment, seq, tokens: body.tokens });
    } else if (action === 'close') {
      const segment = posInt(body.segment, 200);
      const reason = body.reason === 'paused' || body.reason === 'stopped' || body.reason === 'error' ? body.reason : null;
      const audioMs = typeof body.audioMs === 'number' && Number.isFinite(body.audioMs) && body.audioMs >= 0 ? Math.floor(body.audioMs) : null;
      if (!segment || !reason) throw new AiGatewayError('bad_request', 'Neplatné ukončení části.');
      out = await liveClose(ctx, { segment, audioMs: audioMs === null ? null : Math.min(audioMs, 18_000_000), reason });
    } else if (action === 'complete') out = await liveComplete(ctx);
    else out = await liveDiscard(ctx);
    return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof AiGatewayError) return errorResponse(err);
    if (err instanceof SonioxError) return errorResponse(toGatewayError(err));
    console.error('[stt-live] unexpected', (err as Error)?.name);
    return errorResponse(new AiGatewayError('stt_failed', 'Živý přepis se nezdařil. Zkuste to prosím znovu.'));
  }
}
