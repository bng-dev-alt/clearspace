import { NextRequest, NextResponse } from 'next/server';
import { GMAIL_READONLY_SCOPE } from '../../../../lib/google/config';
import { caller, dbError, errorResponse, NO_STORE, requireGoogle } from '../../../../lib/google/server';

/**
 * DELETE /api/gmail/connection[?purge=1] -- turn Gmail OFF for the caller in ClearSpace: ClearSpace stops every Gmail call
 * for this user (the scope is removed from what ClearSpace uses). Google revokes grants only as a whole, so the grant itself
 * stays at Google until the user disconnects the whole Google account (which also ends Drive) or removes it in their Google
 * account settings -- the UI says so. Drive is not touched. `purge=1` also removes every e-mail link this user created
 * (data deletion on request). Works even when the Gmail feature switch is off (users can always remove their data).
 */
export async function DELETE(req: NextRequest) {
  try {
    const cfg = requireGoogle();
    const { db } = await caller(req);
    const { data: removed, error } = await db.rpc('google_service_remove', { p_server_secret: cfg.serverSecret, p_scope: GMAIL_READONLY_SCOPE });
    if (error) throw dbError(error);
    let purged: { removed: number; skipped: number } | null = null;
    if (req.nextUrl.searchParams.get('purge') === '1') {
      const { data, error: pErr } = await db.rpc('gmail_links_purge_mine', { p_server_secret: cfg.serverSecret });
      if (pErr) throw dbError(pErr);
      purged = ((Array.isArray(data) ? data[0] : data) as { removed: number; skipped: number } | undefined) ?? { removed: 0, skipped: 0 };
    }
    return NextResponse.json({ gmailRemoved: Boolean(removed), purged }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'gmail-disconnect');
  }
}
