import { NextRequest } from 'next/server';
import { runSttDelete } from '../../../../../lib/stt/route';
import { purgeAudio } from '../../../../../lib/stt/pipeline';

// Smaže zvuk ze Storage a, je-li přepis nastaven, i data u poskytovatele. NEZÁVISÍ na příznaku STT_ENABLED: vypnutí přepisu
// nesmí zabránit smazání zvuku. (Prohlížeč umí zvuk smazat i bez této routy, viz lib/stt/audioCleanup.ts.)
export const POST = (req: NextRequest) =>
  runSttDelete<{ includeProvider: boolean }>(
    req,
    async (ctx) => ({ ...(await purgeAudio({ ...ctx, includeProvider: ctx.input.includeProvider })) }),
    (b) => ({ includeProvider: b.includeProvider !== false })
  );
