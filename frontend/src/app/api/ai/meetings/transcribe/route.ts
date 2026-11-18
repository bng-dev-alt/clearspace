import { NextRequest } from 'next/server';
import { runStt } from '../../../../../lib/stt/route';
import { startTranscription } from '../../../../../lib/stt/pipeline';

// Spustí přepis zvuku porady (souhlas, rozpočet a idempotence hlídá databáze). Vždy výslovně vyvolané uživatelem.
export const POST = (req: NextRequest) =>
  runStt(req, async ({ db, soniox, projectId, meetingId, limits }) => ({
    ...(await startTranscription({ db, soniox, meetingId, projectId, limits })),
  }));
