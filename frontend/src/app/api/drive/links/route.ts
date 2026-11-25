import { NextRequest, NextResponse } from 'next/server';
import { ENTITY_ID_RE as ID_RE, getFile, isFileId } from '../../../../lib/google/drive';
import { ACCESS_TEXT } from '../../../../lib/google/labels';
import { caller, dbError, errorResponse, getAccessToken, HttpError, MSG, NO_STORE, readJson, requireGoogle } from '../../../../lib/google/server';



/**
 * POST /api/drive/links { projectId, cardId?, fileIds[] } -- link files the caller picked in the Google Picker to
 * a project or a task. Metadata comes from the Drive API with the caller's OWN token (a spoofed name or link from
 * the client is impossible); the database re-checks edit rights and de-duplicates. Nothing is copied or shared.
 */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireGoogle();
    const { db } = await caller(req);
    const body = await readJson<{ projectId?: unknown; cardId?: unknown; fileIds?: unknown }>(req);
    const projectId = typeof body.projectId === 'string' && ID_RE.test(body.projectId) ? body.projectId : null;
    const cardId = body.cardId == null ? null : typeof body.cardId === 'string' && ID_RE.test(body.cardId) ? body.cardId : undefined;
    const fileIds = Array.isArray(body.fileIds) ? [...new Set(body.fileIds)] : [];
    if (!projectId || cardId === undefined || fileIds.length < 1 || fileIds.length > 20 || !fileIds.every(isFileId)) {
      throw new HttpError(400, MSG.invalid, 'invalid');
    }
    // refuse before spending the caller's Google quota (the RPC enforces it again)
    const { data: canEdit, error: roleErr } = await db.rpc('can_edit_project', { p_project_id: projectId });
    if (roleErr) throw dbError(roleErr);
    if (!canEdit) throw new HttpError(403, 'K tomuto projektu nemáte oprávnění přidávat soubory.', 'forbidden');

    let { token } = await getAccessToken(db, cfg, { cost: fileIds.length });
    const links: { id: string; fileId: string; duplicate: boolean }[] = [];
    const failed: { fileId: string; reason: string; message: string }[] = [];
    for (const fileId of fileIds as string[]) {
      let r = await getFile(cfg, token, fileId);
      if (!r.ok && r.reason === 'auth') { token = (await getAccessToken(db, cfg, { force: true, cost: 1 })).token; r = await getFile(cfg, token, fileId); }
      if (!r.ok) { failed.push({ fileId, reason: r.reason, message: ACCESS_TEXT[r.reason] }); continue; }
      const f = r.value;
      const { data, error } = await db.rpc('drive_link_add', {
        p_server_secret: cfg.serverSecret, p_project_id: projectId, p_card_id: cardId, p_external_id: f.externalId,
        p_name: f.name, p_mime_type: f.mimeType, p_web_url: f.webUrl, p_size_bytes: f.sizeBytes,
        p_modified_at: f.modifiedAt, p_provider_state: f.state,
      });
      if (error) throw dbError(error, 'Soubor se nepodařilo připojit.');
      const row = (Array.isArray(data) ? data[0] : data) as { id: string; duplicate: boolean };
      links.push({ id: row.id, fileId, duplicate: row.duplicate });
    }
    return NextResponse.json({ links, failed }, { status: links.some((l) => !l.duplicate) ? 201 : 200, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'drive-links');
  }
}
