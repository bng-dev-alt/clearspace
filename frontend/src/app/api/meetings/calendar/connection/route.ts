import { NextRequest, NextResponse } from 'next/server';
import { CALENDAR_WRITE_SCOPE } from '../../../../../lib/google/config';
import { caller, dbError, errorResponse, MSG, NO_STORE, requireGoogle } from '../../../../../lib/google/server';

/**
 * DELETE /api/meetings/calendar/connection -- RUN 10: stop using the Calendar WRITE permission (meeting scheduling) in ClearSpace.
 * Reading the calendar, Drive and Gmail stay. Events already created stay in the user's calendar. Works with every switch off.
 */
export async function DELETE(req: NextRequest) {
  try {
    const cfg = requireGoogle(MSG.calendar_not_configured);
    const { db } = await caller(req);
    const { data, error } = await db.rpc('google_service_remove', { p_server_secret: cfg.serverSecret, p_scope: CALENDAR_WRITE_SCOPE });
    if (error) throw dbError(error);
    return NextResponse.json({ removed: Boolean(data) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'meetings-calendar-disconnect');
  }
}
