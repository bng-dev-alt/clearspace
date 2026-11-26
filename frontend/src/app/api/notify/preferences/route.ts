import { NextRequest, NextResponse } from 'next/server';
import { authenticateCaller, HttpError } from '../../../../lib/collab/invitationServer';
import { dbError, errorResponse, NO_STORE, readJson } from '../../../../lib/google/server';
import { MSG, requireNotify } from '../../../../lib/notify/server';

const TYPES = ['assignment', 'due_soon', 'mention', 'comment', 'task_completed', 'task_due_changed', 'project_membership'];

/** PUT /api/notify/preferences { eventTypes, projectIds (null = all projects), hideTitles } -- also applies to what is already queued. */
export async function PUT(req: NextRequest) {
  try {
    const cfg = requireNotify();
    const { db } = await authenticateCaller(req.headers.get('authorization'), 'Oznámení vyžadují připojenou databázi.');
    const b = await readJson<{ eventTypes?: unknown; projectIds?: unknown; hideTitles?: unknown }>(req);
    const types = Array.isArray(b.eventTypes) && b.eventTypes.every((t) => typeof t === 'string' && TYPES.includes(t)) ? b.eventTypes as string[] : null;
    const projects = b.projectIds === null ? null
      : Array.isArray(b.projectIds) && b.projectIds.length <= 200 && b.projectIds.every((p) => typeof p === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(p)) ? b.projectIds as string[] : undefined;
    if (!types || projects === undefined || typeof b.hideTitles !== 'boolean') throw new HttpError(400, MSG.invalid, 'invalid');
    const { error } = await db.rpc('notify_prefs_set', { p_server_secret: cfg.serverSecret, p_event_types: types, p_project_ids: projects, p_hide_titles: b.hideTitles });
    if (error) throw dbError(error);
    return NextResponse.json({ saved: true }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'notify-preferences');
  }
}
