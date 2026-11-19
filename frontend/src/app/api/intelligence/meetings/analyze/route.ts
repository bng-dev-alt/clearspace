import { NextRequest } from 'next/server';
import { runAi } from '../../../../../lib/ai/gateway';
import { meetingAnalyze } from '../../../../../lib/ai/meetingAnalyze';

// Veškerá logika (autentizace, seznam vlastníků, oprávnění, limity, validace) žije v gateway. Leží mimo /api/ai (tu drží zavřenou
// produkční firewall); přístup má jen vlastník podle AI_OWNER_USER_IDS.
export const POST = (req: NextRequest) => runAi(req, meetingAnalyze);
