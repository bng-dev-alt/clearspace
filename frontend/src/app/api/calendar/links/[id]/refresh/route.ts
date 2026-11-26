import { NextRequest, NextResponse } from 'next/server';
import { CALENDAR_STATUS, CALENDAR_TEXT, getEvent } from '../../../../../../lib/google/calendar';
import { ownCalendarSource, storeCalendarShared } from '../../../../../../lib/google/calendarLinks';
import { serviceCaller, errorResponse, HttpError, NO_STORE, requireCalendar, withServiceToken } from '../../../../../../lib/google/server';

/**
 * POST /api/calendar/links/:id/refresh -- the person who linked an event re-reads it from their own calendar (title, times,
 * flags, attendee count; cancelled / deleted). Changes reach teammates live (signal-only broadcast). E5: a rescheduled event
 * moves; a cancelled or deleted one is marked 'deleted' and keeps its last known metadata.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const cfg = requireCalendar();
    const { id } = await ctx.params;
    const { db } = await serviceCaller(req, 'calendar');
    const src = await ownCalendarSource(db, cfg, id);
    const r = await withServiceToken('calendar', db, cfg, 1, (token) => getEvent(cfg, token, src.eventId));
    if (!r.ok) throw new HttpError(CALENDAR_STATUS[r.reason] ?? 503, CALENDAR_TEXT[r.reason], r.reason);
    const ev = r.value;
    // an event that turned private after it was linked: only its state is kept fresh, its new metadata is not shared
    const updated = await storeCalendarShared(db, cfg, id, 'title' in ev && ev.state === 'ok' && !ev.private ? ev : { state: ev.state });
    return NextResponse.json({ state: ev.state, private: 'private' in ev ? ev.private : false, updated }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'calendar-refresh');
  }
}
