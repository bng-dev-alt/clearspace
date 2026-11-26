import { after, NextRequest, NextResponse } from 'next/server';
import { HttpError } from '../../../../../lib/collab/invitationServer';
import { taskHref } from '../../../../../lib/hub/dispatch';
import { safeResponseUrl, slackPermalink, slackPost, slackRespond, slackViewsOpen } from '../../../../../lib/hub/providers';
import {
  hubLog, keys, openRef, readRaw, requireHubSlack, serviceDb, svc, TASK_REASON, verifySlack, type ResolvedDestination, type SlackInstallSecret,
} from '../../../../../lib/hub/server';
import { clean } from '../../../../../lib/notify/message';

export const maxDuration = 30;
const SHORTCUT_ID = 'clearspace_create_task';
const VIEW_ID = 'clearspace_task';
const TS = /^[0-9]{6,12}\.[0-9]{1,8}$/;
const ok = () => new NextResponse(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });

interface Meta { ch: string; ts: string; th: string }

/**
 * POST /api/hub/slack/interactivity -- signed Slack interactions of the PROJECT app:
 *   message_action "Vytvořit úkol v ClearSpace" -> a modal with a PREVIEW (title + text, editable) for a channel bound to a project
 *   view_submission -> the task is created AS the verified ClearSpace user mapped to this Slack user (edit rights checked now), the
 *                      message is recorded with its permalink, ClearSpace confirms in the thread and links the thread to the task
 * Nothing is created for unbound channels, unverified users or channels without "Interaktivní".
 */
export async function POST(req: NextRequest) {
  try {
    const { cfg, slack } = requireHubSlack();
    const raw = await readRaw(req);
    if (!verifySlack(slack.signingSecret, req.headers, raw)) { hubLog('slack_bad_signature', { route: 'interactivity' }); return new NextResponse(null, { status: 401 }); }
    let p: Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any
    try { p = JSON.parse(new URLSearchParams(raw).get('payload') ?? ''); } catch { return new NextResponse(null, { status: 400 }); }
    const team = String(p.team?.id ?? p.user?.team_id ?? ''), user = String(p.user?.id ?? '');
    if (!/^T[A-Z0-9]{2,30}$/.test(team) || !/^[UW][A-Z0-9]{2,30}$/.test(user)) return new NextResponse(null, { status: 400 });
    const k = keys(cfg.serverSecret);
    const db = await serviceDb(cfg);
    const installation = async () => {
      const inst = await svc<{ id: string; status: string; secretEnc: string } | null>(db, cfg, 'hub_svc_installation', { p_team_hmac: k.slackTeam(team) });
      return inst && inst.status === 'active' ? openRef<SlackInstallSecret>(cfg, 'installation', inst.id, inst.secretEnc) : null;
    };

    if (p.type === 'message_action' && p.callback_id === SHORTCUT_ID) {
      const ch = String(p.channel?.id ?? ''), msg = p.message ?? {};
      const respondUrl = safeResponseUrl(slack, p.response_url);
      const say = (t: string) => { if (respondUrl) after(() => slackRespond(respondUrl, t)); return ok(); };
      if (!/^[CG][A-Z0-9]{2,30}$/.test(ch) || !TS.test(String(msg.ts ?? ''))) return say('Úkol lze vytvořit jen ze zprávy v kanálu propojeném s projektem.');
      const d = await svc<ResolvedDestination | null>(db, cfg, 'hub_svc_resolve', { p_provider: 'slack', p_ext_key: k.slackChannel(team, ch) });
      if (!d) return say('Tento kanál není propojený s žádným projektem ClearSpace.');
      if (d.status !== 'active') return say(TASK_REASON.destination_inactive);
      if (!d.interactive) return say(TASK_REASON.interactive_off);
      const sec = await installation();
      if (!sec) return say('Aplikace ClearSpace Projekty nemá v tomto workspace platný přístup.');
      const text = String(msg.text ?? '').slice(0, 2900);
      const meta: Meta = { ch, ts: String(msg.ts), th: TS.test(String(msg.thread_ts ?? '')) ? String(msg.thread_ts) : String(msg.ts) };
      const view = {
        type: 'modal', callback_id: VIEW_ID, private_metadata: JSON.stringify(meta),
        title: { type: 'plain_text', text: 'Úkol v ClearSpace' }, submit: { type: 'plain_text', text: 'Vytvořit úkol' }, close: { type: 'plain_text', text: 'Zrušit' },
        blocks: [
          { type: 'context', elements: [{ type: 'plain_text', text: `Projekt: ${clean(d.projectName, 120)} · ${clean(d.label, 80)}` }] },
          { type: 'input', block_id: 'title', label: { type: 'plain_text', text: 'Název úkolu' },
            element: { type: 'plain_text_input', action_id: 'v', max_length: 200, initial_value: clean(text.split('\n')[0], 150) || 'Úkol ze Slacku' } },
          { type: 'input', block_id: 'details', optional: true, label: { type: 'plain_text', text: 'Popis (text zprávy)' },
            element: { type: 'plain_text_input', action_id: 'v', multiline: true, max_length: 3000, ...(text.trim() ? { initial_value: text } : {}) } },
          { type: 'context', elements: [{ type: 'plain_text', text: 'Úkol vytvoříte pod svým propojeným účtem ClearSpace. Odpovědi v tomto vlákně se budou propisovat jako komentáře.' }] },
        ],
      };
      const o = await slackViewsOpen(slack, sec.botToken, String(p.trigger_id ?? ''), view);
      hubLog('slack_shortcut', { outcome: o.outcome });
      return o.outcome === 'sent' ? ok() : say('Okno se nepodařilo otevřít. Zkuste to prosím znovu.');
    }

    if (p.type === 'view_submission' && p.view?.callback_id === VIEW_ID) {
      let meta: Meta;
      try { meta = JSON.parse(String(p.view.private_metadata ?? '')); } catch { return new NextResponse(null, { status: 400 }); }
      if (!/^[CG][A-Z0-9]{2,30}$/.test(meta.ch) || !TS.test(meta.ts) || !TS.test(meta.th)) return new NextResponse(null, { status: 400 });
      const values = p.view.state?.values ?? {};
      const title = String(values.title?.v?.value ?? '').trim(), details = String(values.details?.v?.value ?? '');
      const fail = (m: string) => NextResponse.json({ response_action: 'errors', errors: { title: m } });
      // re-resolve from the CHANNEL (never trust a destination id carried through the client)
      const d = await svc<ResolvedDestination | null>(db, cfg, 'hub_svc_resolve', { p_provider: 'slack', p_ext_key: k.slackChannel(team, meta.ch) });
      if (!d || d.status !== 'active') return fail(TASK_REASON.destination_inactive);
      const sec = await installation();
      if (!sec) return fail('Aplikace ClearSpace Projekty nemá v tomto workspace platný přístup.');
      const permalink = await slackPermalink(slack, sec.botToken, meta.ch, meta.ts);
      const r = await svc<{ ok: boolean; reason?: string; duplicate?: boolean; cardId?: string; projectId?: string; title?: string; projectName?: string }>(db, cfg, 'hub_svc_create_task', {
        p_destination: d.id, p_ext_user: k.slackUser(team, user), p_title: title, p_details: details.slice(0, 4000),
        p_msg_key: k.slackMsg(team, meta.ch, meta.ts), p_author_label: 'Slack', p_text: details.slice(0, 4000), p_permalink: permalink,
        p_sent_at: new Date(Number(meta.ts.split('.')[0]) * 1000).toISOString(),
      });
      hubLog('slack_task', { ok: r.ok, reason: r.reason ?? null, duplicate: r.duplicate ?? false });
      if (!r.ok) return fail(TASK_REASON[r.reason ?? ''] ?? 'Úkol se nepodařilo vytvořit.');
      const href = taskHref(cfg.appBaseUrl, r.projectId ?? d.projectId, r.cardId);
      after(async () => {
        if (!r.duplicate) {
          await svc(db, cfg, 'hub_svc_attach_conversation', { p_destination: d.id, p_card: r.cardId, p_thread_key: k.slackThread(team, meta.ch, meta.th), p_thread_ref: meta.th }).catch(() => null);
        }
        await slackPost(slack, sec.botToken, meta.ch, `${r.duplicate ? 'Úkol už existuje' : 'Vytvořen úkol'} v ClearSpace: „${clean(r.title, 150)}" (${clean(r.projectName, 80)})\n${href}`, meta.th);
      });
      return NextResponse.json({ response_action: 'clear' });
    }
    return ok();
  } catch (err) {
    hubLog('slack_interactivity_error', { code: err instanceof HttpError ? err.code : 'error' });
    if (err instanceof HttpError && err.status === 503 && err.code.startsWith('hub_')) return NextResponse.json({ error: err.code }, { status: 503 });
    return new NextResponse(null, { status: 500 });
  }
}
