import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AiGatewayError } from '../ai/errors';
import { authenticate, errorResponse, readJsonBody, requireProjectId } from '../ai/gateway';
import { SonioxClient, SonioxError, sonioxConfigFromEnv } from './soniox';
import { sttEnabled, sttLimitsFromEnv, toGatewayError, type SttLimits } from './pipeline';

/**
 * Společný obal STT rout (R5): feature flag -> JSON tělo -> autentizace (JWT, RLS klient) -> projekt -> handler.
 * Leží pod /api/ai, takže ho produkční firewall pravidlo "deny /api/ai" drží zavřený, dokud ho vlastník neotevře.
 * Klíč Soniox se čte jen tady na serveru a do odpovědi ani do logu se nikdy nedostane.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SttRouteCtx<I> {
  db: SupabaseClient;
  soniox: SonioxClient;
  projectId: string;
  meetingId: string;
  input: I;
  limits: SttLimits;
}

export async function runStt<I = Record<string, never>>(
  req: NextRequest,
  handler: (ctx: SttRouteCtx<I>) => Promise<Record<string, unknown>>,
  parse: (body: Record<string, unknown>) => I = () => ({}) as I
): Promise<NextResponse> {
  try {
    if (!sttEnabled()) throw new AiGatewayError('stt_disabled', 'Přepis zvuku je v této instalaci zatím vypnutý.');
    const body = await readJsonBody(req, 4096);
    const auth = await authenticate(req);
    const projectId = requireProjectId(body);
    const meetingId = typeof body.meetingId === 'string' && UUID.test(body.meetingId) ? body.meetingId.toLowerCase() : null;
    if (!meetingId) throw new AiGatewayError('bad_request', 'Neplatný identifikátor porady.');
    const input = parse(body);
    const soniox = new SonioxClient(sonioxConfigFromEnv());
    const out = await handler({ db: auth.db, soniox, projectId, meetingId, input, limits: sttLimitsFromEnv() });
    return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof AiGatewayError) return errorResponse(err);
    if (err instanceof SonioxError) return errorResponse(toGatewayError(err));
    console.error('[stt] unexpected', (err as Error)?.name);
    return errorResponse(new AiGatewayError('stt_failed', 'Přepis se nezdařil. Zkuste to prosím znovu.'));
  }
}
