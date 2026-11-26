import { NextRequest, NextResponse } from 'next/server';
import { getContent, GMAIL_TEXT, gmailWebUrl } from '../../../../../../lib/google/gmail';
import { ownSource, storeShared } from '../../../../../../lib/google/gmailLinks';
import { serviceCaller, errorResponse, GMAIL_STATUS, HttpError, NO_STORE, requireGmail, withGmailToken } from '../../../../../../lib/google/server';

/**
 * GET /api/gmail/links/:id/preview -- plain-text preview of ONE linked e-mail / conversation, for the person who linked
 * it, from THEIR OWN mailbox with THEIR OWN token. Teammates never get content (privacy default: linking shares metadata,
 * not the mail). HTML is reduced to text on the server; nothing remote is loaded; attachments: metadata only, never
 * downloaded. Not stored, not logged, not sent to any AI provider. Refreshes the shared metadata as a side effect.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const cfg = requireGmail();
    const { id } = await ctx.params;
    const { db } = await serviceCaller(req, 'gmail');
    const src = await ownSource(db, cfg, id);
    const r = await withGmailToken(db, cfg, 2, (token) => getContent(cfg, token, src.kind, src.gmailId));
    if (!r.ok) {
      if (r.reason === 'not_found') { await storeShared(db, cfg, id, { state: 'deleted' }); throw new HttpError(404, GMAIL_TEXT.deleted, 'deleted'); }
      throw new HttpError(GMAIL_STATUS[r.reason] ?? 503, GMAIL_TEXT[r.reason], r.reason);
    }
    const c = r.value;
    await storeShared(db, cfg, id, { subject: c.subject, from: c.sharedSender, date: c.date, count: c.messageCount, attachments: c.attachmentCount, state: c.state });
    return NextResponse.json({ content: c, webUrl: gmailWebUrl(src.threadId) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'gmail-preview');
  }
}
