import { randomInt } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller } from '../../../../../lib/collab/invitationServer';
import { sha256hex } from '../../../../../lib/google/crypto';
import { dbError, errorResponse, NO_STORE, readJson } from '../../../../../lib/google/server';
import { hubIntelligenceEnabled, hubSlackEnabled, hubTelegramEnabled } from '../../../../../lib/hub/config';
import { hubLog, parseHubProvider, requireHub, requireHubSlack, requireHubTelegram } from '../../../../../lib/hub/server';

const PROJECT_RE = /^[A-Za-z0-9_-]{1,120}$/;
const auth = (req: NextRequest) => authenticateCaller(req.headers.get('authorization'), 'Integrace vyžadují připojenou databázi.');

/** GET /api/hub/projects/:projectId -- destinations, capabilities and (managers) audit of one project, plus which providers this server offers. */
export async function GET(req: NextRequest, ctx: RouteContext<'/api/hub/projects/[projectId]'>) {
  try {
    const cfg = requireHub();
    const { projectId } = await ctx.params;
    if (!PROJECT_RE.test(projectId)) throw dbError({ code: '22023', message: 'Neplatný projekt.' });
    const { db } = await auth(req);
    const { data, error } = await db.rpc('hub_project_status', { p_server_secret: cfg.serverSecret, p_project_id: projectId });
    if (error) throw dbError(error);
    const slackReady = hubSlackEnabled() && !('error' in cfg.slack), telegramReady = hubTelegramEnabled() && !('error' in cfg.telegram);
    return NextResponse.json({
      ...(data as object),
      providers: { slack: slackReady, telegram: telegramReady },
      simulated: { slack: slackReady && !('error' in cfg.slack) && cfg.slack.mock, telegram: telegramReady && !('error' in cfg.telegram) && cfg.telegram.mock },
      telegramBot: telegramReady && !('error' in cfg.telegram) ? cfg.telegram.botUsername : null,
      intelligenceAvailable: hubIntelligenceEnabled(),
    }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'hub-project');
  }
}

/**
 * POST /api/hub/projects/:projectId { provider } -- a single-use linking code (10 min; only its SHA-256 is stored) for a project manager.
 * The code is typed INTO the channel / group (`/clearspace propojit KÓD` in Slack, `/link@bot KÓD` in Telegram); a manager then confirms.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/hub/projects/[projectId]'>) {
  try {
    const b = await readJson<{ provider?: unknown }>(req);
    const provider = parseHubProvider(b.provider);
    const { cfg } = provider === 'slack' ? requireHubSlack() : requireHubTelegram();
    const { projectId } = await ctx.params;
    if (!PROJECT_RE.test(projectId)) throw dbError({ code: '22023', message: 'Neplatný projekt.' });
    const { db } = await auth(req);
    // 10 characters from an unambiguous alphabet: typed by hand, guessed never (single use, 10 min, rate-limited)
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('');
    const { error } = await db.rpc('hub_link_begin', { p_server_secret: cfg.serverSecret, p_project_id: projectId, p_provider: provider, p_code_hash: sha256hex(code) });
    if (error) throw dbError(error);
    hubLog('link_code', { provider });
    const instruction = provider === 'slack'
      ? `V kanálu nejdřív pozvěte aplikaci (/invite @ClearSpace Projekty), pak napište: /clearspace propojit ${code}`
      : `Přidejte bota @${'error' in cfg.telegram ? '' : cfg.telegram.botUsername} do skupiny a napište ve skupině: /link@${'error' in cfg.telegram ? '' : cfg.telegram.botUsername} ${code}`;
    return NextResponse.json({ code, expiresInSeconds: 600, instruction }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'hub-link-code');
  }
}
