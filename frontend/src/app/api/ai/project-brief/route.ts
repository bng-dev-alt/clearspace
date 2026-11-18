import { NextRequest } from 'next/server';
import { runAi } from '../../../../lib/ai/gateway';
import { projectBrief } from '../../../../lib/ai/projectBrief';

// Leží pod /api/ai: produkční firewall pravidlo "deny /api/ai" ji drží zavřenou, dokud ji vlastník neotevře.
export const POST = (req: NextRequest) => runAi(req, projectBrief);
