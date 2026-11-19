import { NextRequest } from 'next/server';
import { runAi } from '../../../../lib/ai/gateway';
import { projectBrief } from '../../../../lib/ai/projectBrief';

// Leží mimo /api/ai (tu drží zavřenou produkční firewall): přístup má jen vlastník podle serverového seznamu (AI_OWNER_USER_IDS, viz lib/ai/owner.ts).
export const POST = (req: NextRequest) => runAi(req, projectBrief);
