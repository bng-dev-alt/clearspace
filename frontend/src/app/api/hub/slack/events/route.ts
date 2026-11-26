import { after, NextRequest, NextResponse } from 'next/server';
import { HttpError } from '../../../../../lib/collab/invitationServer';
import { hubIntelligenceEnabled } from '../../../../../lib/hub/config';
import { hubLog, keys, readRaw, requireHubSlack, serviceDb, svc, verifySlack, type ResolvedDestination } from '../../../../../lib/hub/server';

export const maxDuration = 30;
const TS = /^[0-9]{6,12}\.[0-9]{1,8}$/;
// user-written messages only; joins, topic changes, bot messages etc. are ignored
const HUMAN_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share', 'me_message']);

/**
 * POST /api/hub/slack/events -- Slack Events API of the PROJECT app (signed; 200 within 3 s, work after the response; event_id dedupe).
 *   message.channels / message.groups -> only for a channel bound to a project: a reply in a task-linked thread (interactive) becomes a
 *        task comment / record; other messages are stored ONLY if the destination has Project Intelligence on AND the server allows
 *        ingestion. Everything else is dropped without a trace. Edits / deletions update / blank the stored record.
 *   app_uninstalled / tokens_revoked -> the workspace and all its destinations are cut off at once.
 * The app's own messages (bot_id) are never processed (loop prevention).
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
    const team = String(b.team_id ?? ''), ev = b.event ?? {};
    if (!/^T[A-Z0-9]{2,30}$/.test(team)) return new NextResponse(null, { status: 200 });
    const db = await serviceDb(cfg);
    if (!await svc<boolean>(db, cfg, 'hub_svc_inbox', { p_provider: 'slack', p_event_key: `e:${b.event_id}` })) {
      hubLog('slack_event_duplicate');
      return new NextResponse(null, { status: 200 });
    }
    const k = keys(cfg.serverSecret);
    after(async () => {
      try {
        if (ev.type === 'app_uninstalled' || ev.type === 'tokens_revoked') {
          const n = await svc<number>(db, cfg, 'hub_svc_installation_revoked', { p_team_hmac: k.slackTeam(team) });
          hubLog('slack_revoked', { destinations: n });
          return;
        }
        if (ev.type !== 'message' || !/^[CG][A-Z0-9]{2,30}$/.test(String(ev.channel ?? ''))) return;
        const ch = String(ev.channel);
        const d = await svc<ResolvedDestination | null>(db, cfg, 'hub_svc_resolve', { p_provider: 'slack', p_ext_key: k.slackChannel(team, ch) });
        if (!d || d.status !== 'active' || (!d.interactive && !d.intelligence)) return;
        if (ev.subtype === 'message_changed' || ev.subtype === 'message_deleted') {
          const m = ev.subtype === 'message_changed' ? ev.message ?? {} : { ts: ev.deleted_ts };
          if (m.bot_id || !TS.test(String(m.ts ?? ''))) return;
          await svc(db, cfg, 'hub_svc_message_changed', { p_destination: d.id, p_msg_key: k.slackMsg(team, ch, String(m.ts)),
            p_text: ev.subtype === 'message_changed' ? String(m.text ?? '').slice(0, 4000) : null, p_deleted: ev.subtype === 'message_deleted' });
          return;
        }
        if (ev.bot_id || !HUMAN_SUBTYPES.has(ev.subtype) || !TS.test(String(ev.ts ?? '')) || !/^[UW][A-Z0-9]{2,30}$/.test(String(ev.user ?? ''))) return;
        const threaded = TS.test(String(ev.thread_ts ?? '')) && ev.thread_ts !== ev.ts;
        const ingest = d.intelligence && hubIntelligenceEnabled();
        if (!(threaded && d.interactive) && !ingest) return;      // nothing could be stored -> no further work
        const r = await svc<{ outcome: string; kind?: string; commentId?: string | null }>(db, cfg, 'hub_svc_inbound_message', {
          p_destination: d.id, p_thread_key: threaded ? k.slackThread(team, ch, String(ev.thread_ts)) : null, p_msg_key: k.slackMsg(team, ch, String(ev.ts)),
          p_ext_user: k.slackUser(team, String(ev.user)), p_author_label: 'Člen kanálu (Slack)', p_text: String(ev.text ?? '').slice(0, 4000),
          p_permalink: null, p_sent_at: new Date(Number(String(ev.ts).split('.')[0]) * 1000).toISOString(), p_ingest_allowed: ingest,
        });
        hubLog('slack_message', { outcome: r.outcome, kind: r.kind ?? null, comment: Boolean(r.commentId) });
      } catch (err) {
        hubLog('slack_event_error', { code: err instanceof HttpError ? err.code : 'error' });
      }
    });
    return new NextResponse(null, { status: 200 });
  } catch (err) {
    hubLog('slack_events_error', { code: err instanceof HttpError ? err.code : 'error' });
    if (err instanceof HttpError && err.status === 503) return NextResponse.json({ error: err.code }, { status: 503 });
    return new NextResponse(null, { status: 500 });
  }
}
