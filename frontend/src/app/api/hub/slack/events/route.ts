import { after, NextRequest, NextResponse } from 'next/server';
import { HttpError } from '../../../../../lib/collab/invitationServer';
import { processInbox, receive } from '../../../../../lib/hub/inbound';
import { hubLog, readRaw, requireHubSlack, serviceDb, verifySlack } from '../../../../../lib/hub/server';

export const maxDuration = 30;

/**
 * POST /api/hub/slack/events -- Slack Events API of the PROJECT app (signed). The event is RECORDED durably (event_id dedupe) and
 * answered 200 within Slack's 3 s; the work runs after the response (src/lib/hub/inbound.ts):
 *   message.channels / message.groups -> only for a channel bound to a project (task-thread replies; PI imports where opted in)
 *   app_uninstalled / tokens_revoked  -> the workspace and its destinations are cut off at once
 */
export async function POST(req: NextRequest) {
  try {
    const { cfg, slack } = requireHubSlack();
    const raw = await readRaw(req);
    if (!verifySlack(slack.signingSecret, req.headers, raw)) { hubLog('slack_bad_signature', { route: 'events' }); return new NextResponse(null, { status: 401 }); }
    let b: Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any
    try { b = JSON.parse(raw); } catch { return new NextResponse(null, { status: 400 }); }
    if (b.type === 'url_verification' && typeof b.challenge === 'string' && b.challenge.length <= 200) return NextResponse.json({ challenge: b.challenge });
    if (b.type !== 'event_callback' || typeof b.event_id !== 'string' || !/^[A-Za-z0-9]{4,40}$/.test(b.event_id)) return new NextResponse(null, { status: 200 });
    if (!/^T[A-Z0-9]{2,30}$/.test(String(b.team_id ?? ''))) return new NextResponse(null, { status: 200 });
    const db = await serviceDb(cfg);
    // only what processing needs is kept (and only until it is done)
    const r = await receive({ cfg, db }, 'slack', `e:${b.event_id}`, { src: 'slack', body: { team_id: b.team_id, event: b.event ?? {} } });
    if (!r.process) { hubLog('slack_event_duplicate'); return new NextResponse(null, { status: 200 }); }
    after(() => processInbox({ cfg, db }, r.id).catch(() => hubLog('inbound_process_error')));
    return new NextResponse(null, { status: 200 });
  } catch (err) {
    hubLog('slack_events_error', { code: err instanceof HttpError ? err.code : 'error' });
    if (err instanceof HttpError && (err.status === 503 || err.status === 413)) return NextResponse.json({ error: err.code }, { status: err.status });
    return new NextResponse(null, { status: 500 });     // not recorded -> Slack retries
  }
}
