import { NextRequest, NextResponse } from 'next/server';
import { getTextContent } from '../../../../../../lib/google/drive';
import { ACCESS_TEXT } from '../../../../../../lib/google/labels';
import { caller, dbError, errorResponse, getAccessToken, HttpError, NO_STORE, requireGoogle } from '../../../../../../lib/google/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS: Record<string, number> = { no_access: 403, unsupported: 415, too_large: 413, rate_limited: 429, auth: 409, unavailable: 503 };

/**
 * GET /api/drive/links/:id/content -- plain-text preview of ONE linked file for the caller. Two independent gates:
 * the ClearSpace membership (the link must be visible under the caller's RLS) AND the caller's OWN Google access
 * (their token; never the token of the person who linked it). Text only, bounded, untrusted, not stored, not sent
 * to any AI provider.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const cfg = requireGoogle();
    const { id } = await ctx.params;
    if (!UUID.test(id)) throw new HttpError(404, 'Soubor nebyl nalezen.', 'not_found');
    const { db } = await caller(req);
    const { data: link, error } = await db.from('external_resource_links').select('id, external_id').eq('id', id).maybeSingle();
    if (error) throw dbError(error);
    if (!link) throw new HttpError(404, 'Soubor nebyl nalezen.', 'not_found');
    const { token } = await getAccessToken(db, cfg, { cost: 2 });
    const r = await getTextContent(cfg, token, link.external_id);
    if (!r.ok) throw new HttpError(STATUS[r.reason] ?? 503, ACCESS_TEXT[r.reason], r.reason);
    return NextResponse.json({ content: r.value }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'drive-content');
  }
}
