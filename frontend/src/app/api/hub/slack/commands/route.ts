import { NextRequest, NextResponse } from 'next/server';
import { randomToken, sha256hex } from '../../../../../lib/google/crypto';
import { clean } from '../../../../../lib/notify/message';
import {
  HUB_MSG, hubLog, identityLink, keys, LINK_REASON, normCode, readRaw, requireHubSlack, sealRef, serviceDb, svc, verifySlack, type ResolvedDestination,
} from '../../../../../lib/hub/server';
import { HttpError } from '../../../../../lib/collab/invitationServer';

const HELP = [
  'ClearSpace – příkazy:',
  '• /clearspace propojit KÓD – propojí tento kanál s projektem (kód vytvoří správce v ClearSpace → Projekt → Integrace; aplikaci nejdřív pozvěte do kanálu)',
  '• /clearspace ucet – propojí váš Slack účet s ClearSpace (pak můžete z chatu vytvářet úkoly)',
  '• /clearspace stav – stav propojení tohoto kanálu',
  'Úkol ze zprávy: u zprávy … → Další akce → Vytvořit úkol v ClearSpace.',
].join('\n');

const reply = (text: string) => NextResponse.json({ response_type: 'ephemeral', text }, { headers: { 'Cache-Control': 'no-store' } });

/**
 * POST /api/hub/slack/commands -- the /clearspace slash command of the PROJECT app (signed; answered within Slack's 3 s, ephemeral only).
 * Channel authority = Slack itself lets only channel members run a command there; ClearSpace authority = the single-use code a project
 * manager issued; the binding then still waits for a manager's confirmation in ClearSpace.
 */
export async function POST(req: NextRequest) {
  try {
    const { cfg, slack } = requireHubSlack();
    const raw = await readRaw(req);
    if (!verifySlack(slack.signingSecret, req.headers, raw)) { hubLog('slack_bad_signature', { route: 'commands' }); return new NextResponse(null, { status: 401 }); }
    const f = new URLSearchParams(raw);
    const team = f.get('team_id') ?? '', channel = f.get('channel_id') ?? '', user = f.get('user_id') ?? '';
    if (!/^T[A-Z0-9]{2,30}$/.test(team) || !/^[CGD][A-Z0-9]{2,30}$/.test(channel) || !/^[UW][A-Z0-9]{2,30}$/.test(user)) return reply(HUB_MSG.invalid);
    const [verb = '', ...rest] = (f.get('text') ?? '').trim().split(/\s+/);
    const k = keys(cfg.serverSecret);
    const db = await serviceDb(cfg);

    if (/^(ucet|účet|account)$/i.test(verb)) {
      const code = randomToken(32);
      await svc(db, cfg, 'hub_svc_identity_begin', { p_code_hash: sha256hex(code), p_provider: 'slack', p_ext_user: k.slackUser(team, user),
        p_label: `Slack: ${clean(f.get('user_name'), 60) || 'účet'} (${clean(f.get('team_domain'), 60) || 'workspace'})` });
      hubLog('slack_identity_begin');
      return reply(`Propojte svůj Slack účet s ClearSpace (odkaz platí 10 minut, vidíte ho jen vy): ${identityLink(cfg, code)}`);
    }
    if (/^(propojit|link)$/i.test(verb)) {
      if (channel.startsWith('D')) return reply('Propojit lze jen kanál, ne soukromou konverzaci.');
      const code = normCode(rest.join(''));
      if (!/^[A-Z0-9]{10}$/.test(code)) return reply('Zadejte kód z ClearSpace: /clearspace propojit KÓD');
      const inst = await svc<{ id: string; status: string } | null>(db, cfg, 'hub_svc_installation', { p_team_hmac: k.slackTeam(team) });
      if (!inst || inst.status !== 'active') return reply('Aplikace ClearSpace Projekty není v tomto workspace nainstalovaná přes ClearSpace (Nastavení → Slack pro projekty).');
      const id = await svc<string>(db, cfg, 'hub_svc_new_id', {});
      const r = await svc<{ ok: boolean; reason?: string; projectName?: string }>(db, cfg, 'hub_svc_link_destination', {
        p_id: id, p_code_hash: sha256hex(code), p_provider: 'slack', p_ext_key: k.slackChannel(team, channel),
        p_ext_ref_enc: sealRef(cfg, 'destination', id, { teamId: team, channelId: channel }),
        p_label: `#${clean(f.get('channel_name'), 80) || 'kanál'}`, p_kind: 'slack_channel', p_installation: inst.id,
      });
      hubLog('slack_link', { ok: r.ok, reason: r.reason ?? null });
      if (!r.ok) return reply(LINK_REASON[r.reason ?? ''] ?? HUB_MSG.invalid);
      return reply(`Kanál čeká na potvrzení v ClearSpace (projekt „${clean(r.projectName, 120)}"). Správce projektu ho potvrdí v Projekt → Integrace. Dokud není potvrzený, ClearSpace z kanálu nic nečte ani sem nic nepíše.`);
    }
    if (/^(stav|status)$/i.test(verb)) {
      const d = await svc<ResolvedDestination | null>(db, cfg, 'hub_svc_resolve', { p_provider: 'slack', p_ext_key: k.slackChannel(team, channel) });
      if (!d) return reply('Tento kanál není propojený s žádným projektem ClearSpace.');
      const state: Record<string, string> = { pending: 'čeká na potvrzení', active: 'aktivní', removed_bot: 'aplikace není v kanálu', revoked: 'přístup zrušen', archived: 'archivováno', error: 'chyba' };
      return reply(`Projekt „${clean(d.projectName, 120)}" – ${state[d.status] ?? d.status}. Oznámení: ${d.notify ? 'ano' : 'ne'}, úkoly z chatu: ${d.interactive ? 'ano' : 'ne'}, Project Intelligence: ${d.intelligence ? 'ano' : 'ne'}.`);
    }
    return reply(HELP);
  } catch (err) {
    hubLog('slack_command_error', { code: err instanceof HttpError ? err.code : 'error' });
    if (err instanceof HttpError && err.status === 503 && err.code.startsWith('hub_')) return NextResponse.json({ error: err.code }, { status: 503 });
    return reply(err instanceof HttpError && err.status === 429 ? 'Příliš mnoho pokusů. Zkuste to prosím za chvíli.' : HUB_MSG.unavailable);
  }
}
