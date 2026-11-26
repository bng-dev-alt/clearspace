import { NextRequest, NextResponse } from 'next/server';
import { getItem, GMAIL_TEXT, sharedSender } from '../../../../../../lib/google/gmail';
import { ownSource, storeShared } from '../../../../../../lib/google/gmailLinks';
import { serviceCaller, errorResponse, GMAIL_STATUS, HttpError, NO_STORE, requireGmail, withGmailToken } from '../../../../../../lib/google/server';

/**
 * POST /api/gmail/links/:id/refresh -- the person who linked an e-mail re-reads its metadata from their own mailbox
 * (subject, sender label, date, message count, trashed / deleted). Changes reach teammates live (signal-only broadcast).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const cfg = requireGmail();
    const { id } = await ctx.params;
    const { db } = await serviceCaller(req, 'gmail');
    const src = await ownSource(db, cfg, id);
    const r = await withGmailToken(db, cfg, 1, (token) => getItem(cfg, token, src.kind, src.gmailId));
    if (!r.ok) {
      if (r.reason === 'not_found') return NextResponse.json({ state: 'deleted', updated: await storeShared(db, cfg, id, { state: 'deleted' }) }, { headers: NO_STORE });
      throw new HttpError(GMAIL_STATUS[r.reason] ?? 503, GMAIL_TEXT[r.reason], r.reason);
    }
    const g = r.value;
    const updated = await storeShared(db, cfg, id, { subject: g.subject, from: sharedSender(g.from), date: g.date, count: g.messageCount, state: g.state });
    return NextResponse.json({ state: g.state, updated }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'gmail-refresh');
  }
}
