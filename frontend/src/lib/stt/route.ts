import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AiGatewayError } from '../ai/errors';
import { authenticate, errorResponse, readJsonBody, requireProjectId } from '../ai/gateway';
import { SonioxClient, SonioxError, sonioxConfigFromEnv } from './soniox';
import { sttEnabled, sttLimitsFromEnv, sttServerSecret, toGatewayError, type SttLimits } from './pipeline';

/**
 * Společný obal STT rout (R5): feature flag -> JSON tělo -> autentizace (JWT, RLS klient) -> projekt -> handler.
 * Routy leží pod /api/intelligence (mimo firewallem zavřené /api/ai); authenticate() pustí jen vlastníky z AI_OWNER_USER_IDS.
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
  /** Serverové tajemství pro důvěryhodná RPC (z prostředí, nikdy z požadavku). */
  secret: string;
}

/** Kontext rout pro MAZÁNÍ: poskytovatel a tajemství jsou volitelné (bez nich se smaže zvuk a úklid u poskytovatele zůstane čekat). */
export interface SttDeleteCtx<I> extends Omit<SttRouteCtx<I>, 'soniox' | 'secret'> {
  soniox: SonioxClient | null;
  secret: string | null;
}

async function respond(run: () => Promise<Record<string, unknown>>): Promise<NextResponse> {
  try {
    return NextResponse.json(await run(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof AiGatewayError) return errorResponse(err);
    if (err instanceof SonioxError) return errorResponse(toGatewayError(err));
    console.error('[stt] unexpected', (err as Error)?.name);
    return errorResponse(new AiGatewayError('stt_failed', 'Přepis se nezdařil. Zkuste to prosím znovu.'));
  }
}

async function common<I>(req: NextRequest, parse: (b: Record<string, unknown>) => I, needsMeeting: boolean) {
  const body = await readJsonBody(req, 4096);
  const auth = await authenticate(req);
  const projectId = requireProjectId(body);
  const meetingId = typeof body.meetingId === 'string' && UUID.test(body.meetingId) ? body.meetingId.toLowerCase() : null;
  if (needsMeeting && !meetingId) throw new AiGatewayError('bad_request', 'Neplatný identifikátor porady.');
  return { db: auth.db, projectId, meetingId: meetingId ?? '', input: parse(body), limits: sttLimitsFromEnv() };
}

/** Routy, které PŘEPISUJÍ (transcribe, sync): vyžadují příznak, serverové tajemství i klíč poskytovatele. */
export async function runStt<I = Record<string, never>>(
  req: NextRequest,
  handler: (ctx: SttRouteCtx<I>) => Promise<Record<string, unknown>>,
  parse: (body: Record<string, unknown>) => I = () => ({}) as I,
  opts: { needsMeeting: boolean } = { needsMeeting: true }
): Promise<NextResponse> {
  return respond(async () => {
    if (!sttEnabled()) throw new AiGatewayError('stt_disabled', 'Přepis zvuku je v této instalaci zatím vypnutý.');
    const c = await common(req, parse, opts.needsMeeting);
    const secret = sttServerSecret();
    const soniox = new SonioxClient(sonioxConfigFromEnv());
    return handler({ ...c, soniox, secret });
  });
}

/**
 * Routy, které MAŽOU (purge, sweep): NEZÁVISÍ na příznacích přepisu. Vypnutí přepisu nesmí zabránit smazání zvuku. Chybí-li
 * serverové tajemství nebo klíč poskytovatele, smaže se zvuk a úklid dat u poskytovatele zůstane čekat (`stt_jobs.cleanup_state`).
 * (Prohlížeč umí zvuk smazat i bez této routy, viz audioCleanup.ts; route navíc umí úklid u poskytovatele.)
 */
export async function runSttDelete<I = Record<string, never>>(
  req: NextRequest,
  handler: (ctx: SttDeleteCtx<I>) => Promise<Record<string, unknown>>,
  parse: (body: Record<string, unknown>) => I = () => ({}) as I,
  opts: { needsMeeting: boolean } = { needsMeeting: true }
): Promise<NextResponse> {
  return respond(async () => {
    const c = await common(req, parse, opts.needsMeeting);
    let secret: string | null = null;
    let soniox: SonioxClient | null = null;
    if (sttEnabled()) {
      try {
        secret = sttServerSecret();
        soniox = new SonioxClient(sonioxConfigFromEnv());
      } catch {
        secret = null;
        soniox = null; // nenastaveno: mazání zvuku to nebrání
      }
    }
    return handler({ ...c, soniox, secret });
  });
}
