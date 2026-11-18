import { NextRequest } from 'next/server';
import { runStt } from '../../../../../lib/stt/route';
import { sweepProject } from '../../../../../lib/stt/pipeline';

// Projektový úklid bez cronu: zvuk po termínu retence, osiřelé soubory smazaných porad, úklid dat u poskytovatele.
// Volá ho otevřený seznam porad (jen s povoleným přepisem). Pracuje výhradně pod identitou volajícího (RLS).
export const POST = (req: NextRequest) =>
  runStt(req, async (ctx) => ({ ...(await sweepProject(ctx)) }), undefined, { needsMeeting: false });
