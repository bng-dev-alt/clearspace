import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller } from '../../../../lib/collab/invitationServer';
import { sha256hex } from '../../../../lib/google/crypto';
import { dbError, errorResponse, NO_STORE, readJson } from '../../../../lib/google/server';
import { hubLog, parseHubProvider, requireHub } from '../../../../lib/hub/server';

/**
 * Chat identities (RUN 07): which Slack / Telegram accounts act as ME when creating tasks or replying in linked threads. A link is created
 * only from the chat side (`/clearspace propojit` in Slack, /start in a private chat with the project bot) and confirmed here, signed in.
 *   GET                         -- my linked chat accounts
 *   POST { code }               -- confirm the link I got privately in the chat
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
    const b = await readJson<{ code?: unknown }>(req);
    if (typeof b.code !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(b.code)) throw dbError({ code: '22023', message: 'Odkaz je neplatný.' });
    const { db } = await auth(req);
    const { data, error } = await db.rpc('hub_identity_confirm', { p_server_secret: cfg.serverSecret, p_code_hash: sha256hex(b.code) });
    if (error) throw dbError(error);
    hubLog('identity_linked', { provider: (data as { provider?: string })?.provider ?? null });
    return NextResponse.json(data, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'hub-identity-confirm');
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
