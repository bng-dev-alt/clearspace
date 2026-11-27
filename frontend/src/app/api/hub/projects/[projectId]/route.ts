import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller } from '../../../../../lib/collab/invitationServer';
import { sha256hex } from '../../../../../lib/google/crypto';
import { dbError, errorResponse, NO_STORE, readJson } from '../../../../../lib/google/server';
import { hubIntelligenceEnabled, hubSlackEnabled, hubTelegramEnabled } from '../../../../../lib/hub/config';
import { humanCode, hubLog, parseHubProvider, requireHub, requireHubSlack, requireHubTelegram } from '../../../../../lib/hub/server';

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
      telegramPiBot: telegramReady && !('error' in cfg.telegram) && cfg.telegram.pi && hubIntelligenceEnabled() ? cfg.telegram.pi.botUsername : null,
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
    const code = humanCode();
    const { error } = await db.rpc('hub_link_begin', { p_server_secret: cfg.serverSecret, p_project_id: projectId, p_provider: provider, p_code_hash: sha256hex(code) });
    if (error) throw dbError(error);
    hubLog('link_code', { provider });
    // RUN 08 UX: the exact command to paste + a link that opens the right app (Telegram: adds the bot to a group AND sends the code)
    const bot = 'error' in cfg.telegram ? '' : cfg.telegram.botUsername;
    const body = provider === 'slack'
      ? { command: `/clearspace propojit ${code}`, openUrl: 'slack://open', openLabel: 'Otevřít Slack',
          steps: ['Ve Slacku otevřete kanál, který chcete propojit.', 'Pozvěte do něj aplikaci: /invite @ClearSpace Projekty (stačí jednou).', 'Vložte do kanálu příkaz níže a odešlete.', 'Kanál se tu objeví sám – pak ho potvrďte.'],
          instruction: `V kanálu nejdřív pozvěte aplikaci (/invite @ClearSpace Projekty), pak napište: /clearspace propojit ${code}` }
      : { command: `/link@${bot} ${code}`, openUrl: `https://t.me/${bot}?startgroup=${code}`, openLabel: 'Přidat bota do skupiny',
          steps: ['Klikněte na „Přidat bota do skupiny“ a v Telegramu vyberte skupinu – bot se přidá a kód pošle sám.', 'Nebo bota přidejte ručně a vložte do skupiny příkaz níže.', 'Kód musí poslat zakladatel nebo správce skupiny.', 'Skupina se tu objeví sama – pak ji potvrďte.'],
          instruction: `Přidejte bota @${bot} do skupiny a napište ve skupině: /link@${bot} ${code}` };
    return NextResponse.json({ code, expiresInSeconds: 600, ...body }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'hub-link-code');
  }
}
