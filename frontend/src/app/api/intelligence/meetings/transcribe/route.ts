import { NextRequest } from 'next/server';
import { runStt } from '../../../../../lib/stt/route';
import { startTranscription } from '../../../../../lib/stt/pipeline';

// Spustí přepis zvuku porady (souhlas, rozpočet a idempotence hlídá databáze; odhad i limity určuje server). Vždy výslovně vyvolané uživatelem.
export const POST = (req: NextRequest) =>
  runStt(req, async (ctx) => ({ ...(await startTranscription(ctx)) }));
