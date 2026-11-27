import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller } from '../../../../lib/collab/invitationServer';
import { sha256hex } from '../../../../lib/google/crypto';
import { dbError, errorResponse, NO_STORE, readJson } from '../../../../lib/google/server';
import { humanCode, hubLog, parseHubProvider, requireHub } from '../../../../lib/hub/server';

/**
 * Chat identities: which Slack / Telegram accounts act as ME when creating tasks or replying in linked threads. RUN 07B: the link starts
 * HERE (signed in) with a single-use code that the user then sends FROM the chat account -- a chat account can never bind itself to
 * someone else's ClearSpace account by a forwarded link.
 *   GET                         -- my linked chat accounts
 *   POST { provider }           -- a code (10 min) + where to send it (Telegram: deep link to the bot)
 *   DELETE { provider, key }    -- unlink
 */
const auth = (req: NextRequest) => authenticateCaller(req.headers.get('authorization'), 'Integrace vyžadují připojenou databázi.');

export async function GET(req: NextRequest) {
  try {
    const cfg = requireHub();
    const { db } = await auth(req);
    const { data, error } = await db.rpc('hub_identities_mine', { p_server_secret: cfg.serverSecret });
    if (error) throw dbError(error);
    return NextResponse.json({ identities: data ?? [] }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'hub-identity');
  }
}

export async function POST(req: NextRequest) {
  try {
    const cfg = requireHub();
    const b = await readJson<{ provider?: unknown }>(req);
    const provider = parseHubProvider(b.provider);
    const t = cfg.telegram;
    if (provider === 'telegram' && 'error' in t) throw dbError({ code: '22023', message: 'Telegram pro projekty není na serveru nastavený.' });
    const { db } = await auth(req);
    const code = humanCode();
    const { error } = await db.rpc('hub_identity_begin', { p_server_secret: cfg.serverSecret, p_provider: provider, p_code_hash: sha256hex(code) });
    if (error) throw dbError(error);
    hubLog('identity_begin', { provider });
    return NextResponse.json(provider === 'telegram' && !('error' in t)
      ? { code, expiresInSeconds: 600, url: `https://t.me/${t.botUsername}?start=${code}`, command: `/start ${code}`, openLabel: 'Otevřít Telegram',
          steps: ['Klikněte na „Otevřít Telegram“ – otevře se soukromý chat s projektovým botem.', 'Stiskněte „Start“. (Nebo botovi pošlete příkaz níže.)', 'Propojení se tu potvrdí samo.'],
          instruction: `Otevřete odkaz v Telegramu a stiskněte „Start“ (bot @${t.botUsername}).` }
      : { code, expiresInSeconds: 600, url: 'slack://open', command: `/clearspace ucet ${code}`, openLabel: 'Otevřít Slack',
          steps: ['Otevřete Slack (workspace s aplikací ClearSpace Projekty).', 'Vložte příkaz níže do libovolného kanálu nebo zprávy sobě – uvidíte ho jen vy.', 'Propojení se tu potvrdí samo.'],
          instruction: `Ve Slacku (kdekoli, kde je aplikace ClearSpace Projekty) napište: /clearspace ucet ${code}` }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'hub-identity-begin');
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const cfg = requireHub();
    const b = await readJson<{ provider?: unknown; key?: unknown }>(req);
    const provider = parseHubProvider(b.provider);
    if (typeof b.key !== 'string' || !/^[0-9a-f]{64}$/.test(b.key)) throw dbError({ code: '22023', message: 'Neplatný požadavek.' });
    const { db } = await auth(req);
    const { data, error } = await db.rpc('hub_identity_remove', { p_server_secret: cfg.serverSecret, p_provider: provider, p_key: b.key });
    if (error) throw dbError(error);
    return NextResponse.json({ removed: data === true }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'hub-identity-remove');
  }
}
