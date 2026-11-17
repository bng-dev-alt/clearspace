import { NextRequest } from 'next/server';
import { runAi } from '../../../../lib/ai/gateway';
import { aiFeatures } from '../../../../lib/ai/features';

// Veškerá logika (autentizace, oprávnění, limity, validace) žije v gateway.
export const POST = (req: NextRequest) => runAi(req, aiFeatures.analyzeResource);
