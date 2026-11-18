import { NextRequest } from 'next/server';
import { runStt } from '../../../../../lib/stt/route';
import { syncTranscription } from '../../../../../lib/stt/pipeline';

// Jeden krátký krok: zeptá se poskytovatele na stav, při dokončení uloží přepis a uklidí data u poskytovatele.
// Volá ho otevřená stránka porady (dotazování), nic neběží na pozadí. `cancel: true` ukončí běžící nebo nejistou úlohu
// (už vzniklé náklady zůstávají v rozpočtu).
export const POST = (req: NextRequest) =>
  runStt<{ cancel: boolean }>(
    req,
    async (ctx) => ({ ...(await syncTranscription({ ...ctx, cancel: ctx.input.cancel })) }),
    (b) => ({ cancel: b.cancel === true })
  );
