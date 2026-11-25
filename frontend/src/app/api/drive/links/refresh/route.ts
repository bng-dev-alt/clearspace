import { NextRequest, NextResponse } from 'next/server';
import { ENTITY_ID_RE, getFile } from '../../../../../lib/google/drive';
import type { AccessState } from '../../../../../lib/google/labels';
import { caller, dbError, errorResponse, getAccessToken, HttpError, MSG, NO_STORE, readJson, requireGoogle } from '../../../../../lib/google/server';

const MAX_LINKS = 25;

/**
 * POST /api/drive/links/refresh { projectId, cardId? } -- re-read the metadata of the linked files the caller can
 * see (RLS), with the caller's OWN Google token, bounded to 25 files (oldest check first). Returns the caller's
 * access per link. Only an editor who CAN read the file stores the new metadata; "no access" is never stored
 * (with drive.file it is per user). No events: metadata refreshes are routine.
 */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireGoogle();
    const { db } = await caller(req);
    const body = await readJson<{ projectId?: unknown; cardId?: unknown }>(req);
    const projectId = typeof body.projectId === 'string' && ENTITY_ID_RE.test(body.projectId) ? body.projectId : null;
    const cardId = body.cardId == null ? null : typeof body.cardId === 'string' && ENTITY_ID_RE.test(body.cardId) ? body.cardId : undefined;
    if (!projectId || cardId === undefined) throw new HttpError(400, MSG.invalid, 'invalid');

    let q = db.from('external_resource_links').select('id, external_id').eq('project_id', projectId).eq('provider', 'google_drive')
      .order('metadata_checked_at', { ascending: true }).limit(MAX_LINKS);
    if (cardId) q = q.eq('card_id', cardId);
    const { data: rows, error } = await q;
    if (error) throw dbError(error);
    if (!rows?.length) return NextResponse.json({ statuses: {}, updated: 0 }, { headers: NO_STORE });

    const { data: canEdit } = await db.rpc('can_edit_project', { p_project_id: projectId });
    let token: string;
    try {
      token = (await getAccessToken(db, cfg, { cost: rows.length, service: 'drive' })).token;
    } catch (err) {
      if (err instanceof HttpError && (err.code === 'not_connected' || err.code === 'revoked' || err.code === 'drive_not_granted')) {
        const state: AccessState = err.code === 'revoked' ? 'revoked' : 'not_connected';
        return NextResponse.json({ statuses: Object.fromEntries(rows.map((r) => [r.id, state])), updated: 0 }, { headers: NO_STORE });
      }
      throw err;
    }
    const statuses: Record<string, AccessState> = {};
    let updated = 0;
    // small fixed concurrency: bounded load on Google and on the function's time budget
    const queue = [...rows];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const res = await getFile(cfg, token, r.external_id);
        if (!res.ok) { statuses[r.id] = res.reason; continue; }
        statuses[r.id] = res.value.state;
        if (!canEdit) continue;
        const f = res.value;
        const { data: changed, error: upErr } = await db.rpc('drive_link_refresh', {
          p_server_secret: cfg.serverSecret, p_link_id: r.id, p_name: f.name, p_mime_type: f.mimeType, p_web_url: f.webUrl,
          p_size_bytes: f.sizeBytes, p_modified_at: f.modifiedAt, p_provider_state: f.state,
        });
        if (!upErr && changed) updated++;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return NextResponse.json({ statuses, updated }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'drive-links-refresh');
  }
}
