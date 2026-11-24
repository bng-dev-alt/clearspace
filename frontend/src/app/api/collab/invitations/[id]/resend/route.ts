import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller, deliverInvitation, fromDbError, HttpError, acceptUrl, linkBase } from '../../../../../../lib/collab/invitationServer';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/collab/invitations/<id>/resend -- issues a NEW token (the previous link stops working, validity is
 * renewed to 7 days) and e-mails it again. Throttled in the database (once a minute, 5 per day per invitation).
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/collab/invitations/[id]/resend'>) {
  try {
    const { db } = await authenticateCaller(req.headers.get('authorization'));
    const { id } = await ctx.params;
    if (!/^inv-[0-9a-f]{32}$/.test(id)) throw new HttpError(400, 'Neplatná pozvánka.', 'invalid');
    const { data, error } = await db.rpc('reissue_invitation_token', { p_invitation_id: id });
    if (error) throw fromDbError(error);
    const inv = Array.isArray(data) ? data[0] : data;
    const delivery = await deliverInvitation(db, inv.id, inv.token, 'resend');
    const base = linkBase();
    return NextResponse.json({ id: inv.id, expiresAt: inv.expires_at, delivery, link: base ? acceptUrl(base, inv.token) : null, token: base ? undefined : inv.token }, { headers: NO_STORE });
  } catch (err) {
    const e = err instanceof HttpError ? err : new HttpError(500, 'Pozvánku se nepodařilo znovu odeslat.');
    if (!(err instanceof HttpError)) console.error('[invitations] resend failed:', (err as Error)?.name);
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status, headers: NO_STORE });
  }
}
