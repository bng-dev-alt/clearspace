import { NextRequest, NextResponse } from 'next/server';
import { buildQuery, GMAIL_TEXT, PAGE_TOKEN_RE, search, type GmailKind } from '../../../../lib/google/gmail';
import { serviceCaller, errorResponse, GMAIL_STATUS, HttpError, MSG, NO_STORE, requireGmail, withGmailToken } from '../../../../lib/google/server';

/**
 * GET /api/gmail/search?kind=thread|message&text=&from=&subject=&after=YYYY-MM-DD&before=&pageToken=&pageSize=
 * The caller searches THEIR OWN mailbox (their own token) to pick what to attach. One bounded page (<= 20 items,
 * metadata only: subject, sender, date, count, snippet). Shown only to the caller; nothing is stored or logged.
 */
export async function GET(req: NextRequest) {
  try {
    const cfg = requireGmail();
    const { db } = await serviceCaller(req, 'gmail');
    const p = req.nextUrl.searchParams;
    const kind: GmailKind | null = (p.get('kind') ?? 'thread') === 'thread' ? 'thread' : p.get('kind') === 'message' ? 'message' : null;
    const pageToken = p.get('pageToken');
    const pageSize = Number(p.get('pageSize') ?? 10);
    if (!kind || (pageToken !== null && !PAGE_TOKEN_RE.test(pageToken)) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) {
      throw new HttpError(400, MSG.invalid, 'invalid');
    }
    for (const k of ['text', 'from', 'subject', 'after', 'before']) if ((p.get(k)?.length ?? 0) > 300) throw new HttpError(400, MSG.invalid, 'invalid');
    const q = buildQuery({ text: p.get('text'), from: p.get('from'), subject: p.get('subject'), after: p.get('after'), before: p.get('before') });
    const r = await withGmailToken(db, cfg, 1 + pageSize, (token) => search(cfg, token, { kind, q, pageToken, pageSize }));
    if (!r.ok) throw new HttpError(GMAIL_STATUS[r.reason] ?? 503, GMAIL_TEXT[r.reason], r.reason);
    return NextResponse.json(r.value, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'gmail-search');
  }
}
