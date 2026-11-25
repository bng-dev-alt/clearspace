import { NextRequest, NextResponse } from 'next/server';
import { CALENDAR_STATUS, CALENDAR_TEXT, getEvent } from '../../../../../../lib/google/calendar';
import { ownCalendarSource, storeCalendarShared } from '../../../../../../lib/google/calendarLinks';
import { caller, errorResponse, HttpError, NO_STORE, requireCalendar, withServiceToken } from '../../../../../../lib/google/server';

/**
 * GET /api/calendar/links/:id/open -- Google's own page of the event (htmlLink), for the person who linked it only, read
 * from THEIR calendar with THEIR token. The link is never stored nor shown to teammates (it would identify the calendar).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const cfg = requireCalendar();
    const { id } = await ctx.params;
    const { db } = await caller(req);
    const src = await ownCalendarSource(db, cfg, id);
    const r = await withServiceToken('calendar', db, cfg, 1, (token) => getEvent(cfg, token, src.eventId));
    if (!r.ok) throw new HttpError(CALENDAR_STATUS[r.reason] ?? 503, CALENDAR_TEXT[r.reason], r.reason);
    const ev = r.value;
    if (!('title' in ev) || ev.state === 'deleted' || !ev.htmlLink) {
      await storeCalendarShared(db, cfg, id, { state: 'deleted' });
      throw new HttpError(404, CALENDAR_TEXT.deleted, 'deleted');
    }
    return NextResponse.json({ url: ev.htmlLink }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'calendar-open');
  }
}
