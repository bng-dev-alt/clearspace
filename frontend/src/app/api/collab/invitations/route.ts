import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller, deliverInvitation, fromDbError, HttpError, acceptUrl, linkBase } from '../../../../lib/collab/invitationServer';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/collab/invitations { projectId, email, role } -- create a project invitation (the database decides
 * whether the caller may) and send the Czech invitation e-mail. Returns the invitation, the delivery result and
 * the link for the optional copy fallback (only to the inviter, only in this response).
 */
export async function POST(req: NextRequest) {
  try {
    const { db } = await authenticateCaller(req.headers.get('authorization'));
    const body = (await req.json().catch(() => null)) as { projectId?: unknown; email?: unknown; role?: unknown } | null;
    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const role = typeof body?.role === 'string' ? body.role : '';
    if (!projectId || projectId.length > 200 || !email || email.length > 254 || !['admin', 'member', 'viewer'].includes(role)) {
      throw new HttpError(400, 'Neplatné údaje pozvánky.', 'invalid');
    }
    const { data, error } = await db.rpc('create_project_invitation', { p_project_id: projectId, p_email: email, p_role: role });
    if (error) throw fromDbError(error);
    const inv = Array.isArray(data) ? data[0] : data;
    const delivery = await deliverInvitation(db, inv.id, inv.token, 'invite');
    const base = linkBase();
    return NextResponse.json({ id: inv.id, expiresAt: inv.expires_at, delivery, link: base ? acceptUrl(base, inv.token) : null, token: base ? undefined : inv.token }, { status: 201, headers: NO_STORE });
  } catch (err) {
    const e = err instanceof HttpError ? err : new HttpError(500, 'Pozvánku se nepodařilo vytvořit.');
    if (!(err instanceof HttpError)) console.error('[invitations] create failed:', (err as Error)?.name);
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status, headers: NO_STORE });
  }
}
