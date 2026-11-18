import { NextRequest } from 'next/server';
import { runStt } from '../../../../../lib/stt/route';
import { purgeAudio } from '../../../../../lib/stt/pipeline';

// Smaže zvuk ze Storage (a volitelně data u poskytovatele). Používá se při ruční akci "Smazat zvuk" i před smazáním porady.
export const POST = (req: NextRequest) =>
  runStt<{ includeProvider: boolean }>(
    req,
    async (ctx) => ({ ...(await purgeAudio({ ...ctx, includeProvider: ctx.input.includeProvider })) }),
    (b) => ({ includeProvider: b.includeProvider !== false })
  );
