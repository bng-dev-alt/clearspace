import { NextRequest, NextResponse } from 'next/server';
import { CALENDAR_READONLY_SCOPE } from '../../../../lib/google/config';
import { caller, dbError, errorResponse, MSG, NO_STORE, requireGoogle } from '../../../../lib/google/server';

/**
 * DELETE /api/calendar/connection[?purge=1] -- turn Google Calendar OFF for the caller in ClearSpace: every Calendar call stops
 * for this user (the scope is removed from what ClearSpace uses). Google revokes grants only as a whole, so the grant stays at
 * Google until the user disconnects the whole Google account (which also ends Drive and Gmail) -- the UI says so. Drive and Gmail
 * are not touched. `purge=1` also removes every event link this user created. Works even when the Calendar switch is off
 * (users can always remove their data).
 */
export async function DELETE(req: NextRequest) {
  try {
    const cfg = requireGoogle(MSG.calendar_not_configured);
    const { db } = await caller(req);
    const { data: removed, error } = await db.rpc('google_service_remove', { p_server_secret: cfg.serverSecret, p_scope: CALENDAR_READONLY_SCOPE });
    if (error) throw dbError(error);
    let purged: { removed: number; skipped: number } | null = null;
    if (req.nextUrl.searchParams.get('purge') === '1') {
      const { data, error: pErr } = await db.rpc('calendar_links_purge_mine', { p_server_secret: cfg.serverSecret });
      if (pErr) throw dbError(pErr);
      purged = ((Array.isArray(data) ? data[0] : data) as { removed: number; skipped: number } | undefined) ?? { removed: 0, skipped: 0 };
    }
    return NextResponse.json({ calendarRemoved: Boolean(removed), purged }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'calendar-disconnect');
  }
}
