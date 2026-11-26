import { NextRequest, NextResponse } from 'next/server';
import { ENTITY_ID_RE } from '../../../../lib/google/drive';
import { getItem, GMAIL_TEXT, isGmailId, linkRef, sharedSender, type GmailKind } from '../../../../lib/google/gmail';
import { serviceCaller, dbError, errorResponse, HttpError, MSG, NO_STORE, readJson, requireGmail, withGmailToken } from '../../../../lib/google/server';

/**
 * POST /api/gmail/links { projectId, cardId?, items: [{ kind: 'message'|'thread', id }] } -- attach e-mails the caller
 * explicitly selected in their own mailbox. The server re-reads each item from Gmail with the caller's OWN token (an id
 * from another mailbox, or a forged one, is simply not found), stores ONLY the shared metadata (subject, sender name or
 * domain, date, count) and keeps the Gmail id private (gmail_link_sources). Nothing is copied, sent or changed in Gmail.
 */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireGmail();
    const { db } = await serviceCaller(req, 'gmail');
    const body = await readJson<{ projectId?: unknown; cardId?: unknown; items?: unknown }>(req);
    const projectId = typeof body.projectId === 'string' && ENTITY_ID_RE.test(body.projectId) ? body.projectId : null;
    const cardId = body.cardId == null ? null : typeof body.cardId === 'string' && ENTITY_ID_RE.test(body.cardId) ? body.cardId : undefined;
    const raw = Array.isArray(body.items) ? body.items as { kind?: unknown; id?: unknown }[] : [];
    const items = [...new Map(raw.map((i) => [`${i?.kind}:${i?.id}`, i])).values()];
    if (!projectId || cardId === undefined || items.length < 1 || items.length > 10
        || !items.every((i) => (i.kind === 'message' || i.kind === 'thread') && isGmailId(i.id))) {
      throw new HttpError(400, MSG.invalid, 'invalid');
    }
    const { data: canEdit, error: roleErr } = await db.rpc('can_edit_project', { p_project_id: projectId });
    if (roleErr) throw dbError(roleErr);
    if (!canEdit) throw new HttpError(403, 'K tomuto projektu nemáte oprávnění připojovat e-maily.', 'forbidden');
    const { data: subData, error: subErr } = await db.rpc('google_connection_sub', { p_server_secret: cfg.serverSecret, p_candidate_sub: '-' });
    if (subErr) throw dbError(subErr);
    const sub = ((Array.isArray(subData) ? subData[0] : subData) as { own_sub: string | null } | undefined)?.own_sub;
    if (!sub) throw new HttpError(409, MSG.not_connected, 'not_connected');

    const links: { id: string; kind: GmailKind; itemId: string; duplicate: boolean }[] = [];
    const failed: { kind: GmailKind; itemId: string; reason: string; message: string }[] = [];
    for (const it of items as { kind: GmailKind; id: string }[]) {
      const r = await withGmailToken(db, cfg, 1, (token) => getItem(cfg, token, it.kind, it.id));
      if (!r.ok) { failed.push({ kind: it.kind, itemId: it.id, reason: r.reason, message: GMAIL_TEXT[r.reason] }); continue; }
      const g = r.value;
      const { data, error } = await db.rpc('gmail_link_add', {
        p_server_secret: cfg.serverSecret, p_project_id: projectId, p_card_id: cardId, p_kind: it.kind,
        p_ref: linkRef(cfg, sub, it.kind, g.id), p_google_sub: sub, p_gmail_id: g.id, p_thread_id: g.threadId,
        p_subject: g.subject, p_from: sharedSender(g.from), p_date: g.date, p_count: g.messageCount, p_attachments: null, p_state: g.state,
      });
      if (error) throw dbError(error, 'E-mail se nepodařilo připojit.');
      const row = (Array.isArray(data) ? data[0] : data) as { id: string; duplicate: boolean };
      links.push({ id: row.id, kind: it.kind, itemId: it.id, duplicate: row.duplicate });
    }
    return NextResponse.json({ links, failed }, { status: links.some((l) => !l.duplicate) ? 201 : 200, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'gmail-links');
  }
}
