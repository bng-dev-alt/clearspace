import { NextRequest } from 'next/server';
import { runAi } from '../../../../../lib/ai/gateway';
import { meetingAnalyze } from '../../../../../lib/ai/meetingAnalyze';

// Veškerá logika (autentizace, oprávnění, limity, validace) žije v gateway; leží pod /api/ai, takže ji
// produkční firewall pravidlo "deny /api/ai" drží zavřenou, dokud ji vlastník výslovně neotevře.
export const POST = (req: NextRequest) => runAi(req, meetingAnalyze);
