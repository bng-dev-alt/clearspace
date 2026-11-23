import { NextRequest, NextResponse } from 'next/server';
import { AiGatewayError } from '../../../../lib/ai/errors';
import { authenticate, errorResponse } from '../../../../lib/ai/gateway';
import { policyFor } from '../../../../lib/ai/policy';
import { sttEnabled } from '../../../../lib/stt/pipeline';

// "Mám přístup?" jen pro UX (zobrazení voleb zvuku a AI). Neoprávňuje k ničemu: každá AI/STT cesta si seznam vlastníků ověřuje sama.
// Anonym: 401. Přihlášený: { aiOwner, stt } bez dalších údajů (žádný seznam vlastníků, žádná konfigurace).
export async function POST(req: NextRequest) {
  try {
    const { tier } = await authenticate(req, { gate: false });
    const aiOwner = tier !== null;
    return NextResponse.json({ aiOwner, stt: aiOwner && policyFor(tier).stt.allowed && sttEnabled() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return errorResponse(err instanceof AiGatewayError ? err : new AiGatewayError('ai_failed', 'Služba AI selhala. Zkuste to prosím znovu.'));
  }
}
