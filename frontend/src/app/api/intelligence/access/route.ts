import { NextRequest, NextResponse } from 'next/server';
import { AiGatewayError } from '../../../../lib/ai/errors';
import { authenticate, errorResponse } from '../../../../lib/ai/gateway';
import { policyFor } from '../../../../lib/ai/policy';
import { sttEnabled } from '../../../../lib/stt/pipeline';
import { inLivePilot, liveConfigFromEnv } from '../../../../lib/stt/live';
import { serviceAllowedFor, serviceMode } from '../../../../lib/google/config';
import { aiStatusFor } from '../../../../lib/ai/status';

// "Mám přístup?" jen pro UX (zobrazení voleb zvuku a AI). Neoprávňuje k ničemu: každá AI/STT cesta si seznam vlastníků ověřuje sama.
// Anonym: 401. Přihlášený: { aiOwner, stt, live, schedule, ai } – booleany + RUN 11 `ai`: limity a model JEN pro volajícího, spočítané stejnou
// politikou, kterou server vynucuje (lib/ai/status.ts). Žádný seznam vlastníků ani pilotů, žádné klíče, nic o jiných účtech.
export async function POST(req: NextRequest) {
  try {
    const { tier, user } = await authenticate(req, { gate: false });
    const aiOwner = tier !== null;
    const stt = aiOwner && policyFor(tier).stt.allowed && sttEnabled();
    // RUN 10 (UX only): live transcription = STT + live switch + meeting pilot; scheduling = Calendar on + 'meetings' service for this user
    const lc = liveConfigFromEnv();
    const live = stt && lc.enabled && inLivePilot(lc, user.id);
    const schedule = serviceMode('calendar') !== 'off' && serviceAllowedFor('calendar', user.id) && serviceAllowedFor('meetings', user.id);
    return NextResponse.json({ aiOwner, stt, live, schedule, ai: aiStatusFor(tier) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return errorResponse(err instanceof AiGatewayError ? err : new AiGatewayError('ai_failed', 'Služba AI selhala. Zkuste to prosím znovu.'));
  }
}
