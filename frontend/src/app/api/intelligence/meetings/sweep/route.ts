import { NextRequest } from 'next/server';
import { runSttDelete } from '../../../../../lib/stt/route';
import { sweepProject } from '../../../../../lib/stt/pipeline';

// Projektový úklid bez cronu: zvuk po termínu, osiřelé a nepřipojené soubory, úklid dat u poskytovatele (jen je-li přepis nastaven).
// Volá ho otevřený seznam porad. Pracuje pod identitou volajícího (RLS) a NEZÁVISÍ na příznaku STT_ENABLED.
export const POST = (req: NextRequest) =>
  runSttDelete(req, async (ctx) => ({ ...(await sweepProject(ctx)) }), undefined, { needsMeeting: false });
