import { NextRequest, NextResponse } from 'next/server';
import { CALENDAR_STATUS, CALENDAR_TEXT, listEvents, PAGE_TOKEN_RE, parseRange } from '../../../../lib/google/calendar';
import { serviceCaller, errorResponse, HttpError, MSG, NO_STORE, requireCalendar, withServiceToken } from '../../../../lib/google/server';

/**
 * GET /api/calendar/events?from=<ISO>&to=<ISO>[&q=][&pageToken=][&pageSize=1..250]
 * The caller's OWN primary-calendar events overlapping [from, to) (at most 42 days), read with their own token: for their
 * personal layer in the project calendar and for picking what to attach. Shown only to the caller; nothing is stored or
 * logged. Private / confidential events are included (it is their own calendar) but flagged: they can never be attached.
 */
export async function GET(req: NextRequest) {
  try {
    const cfg = requireCalendar();
    const { db } = await serviceCaller(req, 'calendar');
    const p = req.nextUrl.searchParams;
    const range = parseRange(p.get('from'), p.get('to'));
    if (!range) throw new HttpError(400, CALENDAR_TEXT.range, 'invalid_range');
    const pageToken = p.get('pageToken');
    const pageSize = Number(p.get('pageSize') ?? 20);
    const q = p.get('q') ?? '';
    if ((pageToken !== null && !PAGE_TOKEN_RE.test(pageToken)) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250 || q.length > 200) {
      throw new HttpError(400, MSG.invalid, 'invalid');
    }
    const r = await withServiceToken('calendar', db, cfg, 1, (token) => listEvents(cfg, token, { ...range, q, pageToken, pageSize }));
    if (!r.ok) throw new HttpError(CALENDAR_STATUS[r.reason] ?? 503, CALENDAR_TEXT[r.reason], r.reason);
    return NextResponse.json(r.value, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'calendar-events');
  }
}
