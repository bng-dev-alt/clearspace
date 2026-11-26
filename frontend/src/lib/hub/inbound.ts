import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '../collab/invitationServer';
import { sha256hex } from '../google/crypto';
import { clean } from '../notify/message';
import { hubIntelligenceEnabled, type HubConfig, type HubTelegram } from './config';
import { taskHref } from './dispatch';
import { parseCommand, slackPermalink, telegramIsGroupAdmin, telegramMessageLink, telegramPost, type Sent } from './providers';
import {
  hubLog, keys, LINK_REASON, normCode, openRef, sealRef, svc, TASK_REASON, type ResolvedDestination, type SlackInstallSecret,
} from './server';

/**
 * Durable inbound processing (RUN 07B). A webhook only VERIFIES and RECORDS an event (hub_inbox: received + payload); this module then
 * claims it (lease), runs its effects (all idempotent per source message / code, advisory-locked in the database), marks it "replying"
 * and only then sends chat replies. Outcomes:
 *   effects failed retryably (database / network) -> retry with backoff, terminal after 5 attempts (payload dropped)
 *   replies began                                  -> never processed again: an interrupted reply is NOT re-sent (ambiguous outbound)
 * The dispatcher (scheduler) picks up anything a crashed request left behind. Mocks and live providers take the same path.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Msg = Record<string, any>;
export type InboundSource = 'telegram' | 'telegram_pi' | 'slack';
export interface InboundPayload { src: InboundSource; body: Msg }
export interface Reply { send: () => Promise<Sent>; after?: (sent: Sent) => Promise<void> }
type Ctx = { cfg: HubConfig; db: SupabaseClient };

const HELP_GROUP = (bot: string) => [
  'ClearSpace – příkazy ve skupině:',
  `• /link@${bot} KÓD – propojí skupinu s projektem (jen zakladatel/správce skupiny; kód vytvoří správce projektu v ClearSpace → Projekt → Integrace)`,
  `• /task@${bot} [název] – jako odpověď na zprávu vytvoří úkol (účet musíte mít propojený)`,
  '• Odpovědi na potvrzení úkolu od bota se propisují jako komentáře k úkolu.',
  '• Propojení účtu: v ClearSpace → Nastavení → Slack a Telegram pro projekty → Propojit Telegram.',
  'Bot vidí jen příkazy pro sebe a odpovědi na své zprávy (režim soukromí Telegramu je zapnutý).',
].join('\n');
const HELP_PRIVATE = 'ClearSpace – projektový bot.\nÚčet propojíte v ClearSpace → Nastavení → Slack a Telegram pro projekty → Propojit Telegram (odkaz otevře tento chat s kódem).\nSoukromé zprávy se nikam neukládají.';

// ------------------------------------------------------------------ processing
export async function receive(ctx: Ctx, provider: 'slack' | 'telegram', eventKey: string, payload: InboundPayload): Promise<{ id: string; process: boolean }> {
  const r = await svc<{ id: string; new: boolean; status: string }>(ctx.db, ctx.cfg, 'hub_svc_inbox_receive', { p_provider: provider, p_event_key: eventKey, p_payload: payload });
  // a provider retry after OUR crash finds the event still received / retry: process it now (the claim decides who wins)
  return { id: r.id, process: r.new || r.status === 'received' || r.status === 'retry' };
}

const retryable = (err: unknown) => !(err instanceof HttpError) || err.status >= 500 || err.status === 429;

export async function processInbox(ctx: Ctx, id: string): Promise<'completed' | 'retry' | 'failed' | 'skipped'> {
  const c = await svc<{ id: string; payload: InboundPayload | null; attempt: number } | null>(ctx.db, ctx.cfg, 'hub_svc_inbox_claim', { p_id: id, p_lease_seconds: 60 });
  if (!c) return 'skipped';
  let replies: Reply[];
  try {
    replies = c.payload ? await handle(ctx, c.payload) : [];
  } catch (err) {
    const outcome = retryable(err) ? 'retry' : 'failed';
    const code = err instanceof HttpError ? err.code.replace(/[^a-z0-9_]/g, '_').slice(0, 60) || 'error' : 'error';
    const st = await svc<string>(ctx.db, ctx.cfg, 'hub_svc_inbox_done', { p_id: id, p_outcome: outcome, p_error_code: code }).catch(() => 'unknown');
    hubLog('inbound_failed', { code, outcome: st, attempt: c.attempt });
    return st === 'retry' ? 'retry' : 'failed';
  }
  if (replies.length) await svc(ctx.db, ctx.cfg, 'hub_svc_inbox_replying', { p_id: id });
  for (const r of replies) {
    try {
      const sent = await r.send();
      if (r.after) await r.after(sent);
    } catch { hubLog('inbound_reply_failed'); }   // at most once: never retried
  }
  await svc(ctx.db, ctx.cfg, 'hub_svc_inbox_done', { p_id: id, p_outcome: 'completed', p_error_code: null });
  return 'completed';
}

/** Work a crashed request left behind (called by the dispatcher). */
export async function processDue(ctx: Ctx, budgetMs: number): Promise<Record<string, number>> {
  const started = Date.now(), out: Record<string, number> = { completed: 0, retry: 0, failed: 0, skipped: 0 };
  const ids = await svc<string[]>(ctx.db, ctx.cfg, 'hub_svc_inbox_due', { p_limit: 20 });
  for (const id of ids ?? []) {
    if (Date.now() - started > budgetMs) break;
    out[await processInbox(ctx, id)] += 1;
  }
  return out;
}

function handle(ctx: Ctx, p: InboundPayload): Promise<Reply[]> {
  if (p.src === 'slack') return handleSlackEvent(ctx, p.body);
  if ('error' in ctx.cfg.telegram) throw new HttpError(503, 'telegram not configured', 'hub_telegram_not_configured');
  return p.src === 'telegram_pi' ? handleTelegramPi(ctx, ctx.cfg.telegram, p.body) : handleTelegram(ctx, ctx.cfg.telegram, p.body);
}

// ------------------------------------------------------------------ Slack Events
const TS = /^[0-9]{6,12}\.[0-9]{1,8}$/;
const HUMAN_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share', 'me_message']);

async function handleSlackEvent({ cfg, db }: Ctx, b: Msg): Promise<Reply[]> {
  const team = String(b.team_id ?? ''), ev = b.event ?? {};
  const k = keys(cfg.routingKey);
  if (ev.type === 'app_uninstalled' || ev.type === 'tokens_revoked') {
    const n = await svc<number>(db, cfg, 'hub_svc_installation_revoked', { p_team_hmac: k.slackTeam(team) });
    hubLog('slack_revoked', { destinations: n });
    return [];
  }
  if (ev.type !== 'message' || !/^[CG][A-Z0-9]{2,30}$/.test(String(ev.channel ?? ''))) return [];
  const ch = String(ev.channel);
  const d = await svc<ResolvedDestination | null>(db, cfg, 'hub_svc_resolve', { p_provider: 'slack', p_ext_key: k.slackChannel(team, ch) });
  if (!d || d.status !== 'active' || (!d.interactive && !d.intelligence)) return [];
  if (ev.subtype === 'message_changed' || ev.subtype === 'message_deleted') {
    const m = ev.subtype === 'message_changed' ? ev.message ?? {} : { ts: ev.deleted_ts };
    if (m.bot_id || !TS.test(String(m.ts ?? ''))) return [];
    await svc(db, cfg, 'hub_svc_message_changed', { p_destination: d.id, p_msg_key: k.slackMsg(team, ch, String(m.ts)),
      p_text: ev.subtype === 'message_changed' ? String(m.text ?? '').slice(0, 4000) : null, p_deleted: ev.subtype === 'message_deleted' });
    return [];
  }
  if (ev.bot_id || !HUMAN_SUBTYPES.has(ev.subtype) || !TS.test(String(ev.ts ?? '')) || !/^[UW][A-Z0-9]{2,30}$/.test(String(ev.user ?? ''))) return [];
  const threaded = TS.test(String(ev.thread_ts ?? '')) && ev.thread_ts !== ev.ts;
  const ingest = d.intelligence && hubIntelligenceEnabled();
  if (!(threaded && d.interactive) && !ingest) return [];
  const msgKey = k.slackMsg(team, ch, String(ev.ts));
  const r = await svc<{ outcome: string; kind?: string; commentId?: string | null }>(db, cfg, 'hub_svc_inbound_message', {
    p_destination: d.id, p_thread_key: threaded ? k.slackThread(team, ch, String(ev.thread_ts)) : null, p_msg_key: msgKey,
    p_ext_user: k.slackUser(team, String(ev.user)), p_author_label: 'Člen kanálu (Slack)', p_text: String(ev.text ?? '').slice(0, 4000),
    p_permalink: null, p_sent_at: new Date(Number(String(ev.ts).split('.')[0]) * 1000).toISOString(), p_ingest_allowed: ingest,
  });
  hubLog('slack_message', { outcome: r.outcome, kind: r.kind ?? null, comment: Boolean(r.commentId) });
  // provenance: the original message link for a kept record (read-only provider call; safe to repeat on retry)
  if (r.outcome === 'stored' && !('error' in cfg.slack) && d.installationId) {
    const inst = await svc<{ id: string; status: string; secretEnc: string } | null>(db, cfg, 'hub_svc_installation', { p_team_hmac: k.slackTeam(team) });
    if (inst?.status === 'active') {
      const link = await slackPermalink(cfg.slack, openRef<SlackInstallSecret>(cfg, 'installation', inst.id, inst.secretEnc).botToken, ch, String(ev.ts));
      if (link) await svc(db, cfg, 'hub_svc_message_permalink', { p_destination: d.id, p_msg_key: msgKey, p_permalink: link });
    }
  }
  return [];
}

// ------------------------------------------------------------------ Telegram project bot (privacy mode ON)
async function handleTelegram({ cfg, db }: Ctx, tg: HubTelegram, u: Msg): Promise<Reply[]> {
  const k = keys(cfg.routingKey);
  const replies: Reply[] = [];
  const resolve = (chat: number) => svc<ResolvedDestination | null>(db, cfg, 'hub_svc_resolve', { p_provider: 'telegram', p_ext_key: k.tgChat(chat) });

  if (u.my_chat_member) {
    // removal is tracked; being ADDED BACK does not re-activate (a manager re-checks it in ClearSpace -- the group may have changed hands)
    const chat = Number(u.my_chat_member.chat?.id), st = String(u.my_chat_member.new_chat_member?.status ?? '');
    if (!Number.isSafeInteger(chat)) return replies;
    const d = await resolve(chat);
    if (d && d.status === 'active' && (st === 'left' || st === 'kicked')) {
      await svc(db, cfg, 'hub_svc_destination_state', { p_destination: d.id, p_status: 'removed_bot', p_error: 'telegram_bot_removed' });
    }
    hubLog('telegram_membership', { status: st });
    return replies;
  }
  if (u.edited_message) {
    const m: Msg = u.edited_message, chat = Number(m.chat?.id);
    if (!Number.isSafeInteger(chat) || m.chat?.type === 'private' || m.from?.is_bot) return replies;
    const d = await resolve(chat);
    if (d?.status === 'active') {
      await svc(db, cfg, 'hub_svc_message_changed', { p_destination: d.id, p_msg_key: k.tgMsg(chat, Number(m.message_id)), p_text: String(m.text ?? m.caption ?? '').slice(0, 4000), p_deleted: false });
    }
    return replies;
  }
  const m: Msg | undefined = u.message;
  if (!m) return replies;
  const chat = Number(m.chat?.id), type = String(m.chat?.type ?? ''), from: Msg = m.from ?? {};
  if (!Number.isSafeInteger(chat)) return replies;
  const say = (text: string, replyTo?: number, after?: Reply['after']) => { replies.push({ send: () => telegramPost(tg, chat, text, replyTo), after }); };

  if (Number.isSafeInteger(m.migrate_to_chat_id)) {
    const d = await resolve(chat);
    if (d) {
      const moved = await svc<boolean>(db, cfg, 'hub_svc_migrate', { p_old_key: k.tgChat(chat), p_new_key: k.tgChat(m.migrate_to_chat_id),
        p_new_ref_enc: sealRef(cfg, 'destination', d.id, { chatId: m.migrate_to_chat_id }), p_destination: d.id });
      hubLog('telegram_migrated', { moved });
    }
    return replies;
  }
  if (from.is_bot || !Number.isSafeInteger(from.id)) return replies;
  const text = String(m.text ?? '');
  const cmd = text.startsWith('/') ? parseCommand(text, tg.botUsername) : null;

  if (type === 'private') {
    // identity: the code was created by the SIGNED-IN ClearSpace user and arrives from this Telegram account (deep link /start KÓD)
    const code = cmd && (cmd.cmd === 'start' || cmd.cmd === 'ucet') ? normCode(cmd.args) : '';
    if (/^[A-Z0-9]{10}$/.test(code)) {
      const label = `Telegram: ${from.username ? `@${clean(from.username, 40)}` : clean(from.first_name, 60) || 'účet'}`;
      const r = await svc<{ ok: boolean; name?: string; reason?: string }>(db, cfg, 'hub_svc_identity_complete', {
        p_code_hash: sha256hex(code), p_provider: 'telegram', p_ext_user: k.tgUser(from.id), p_label: label });
      hubLog('telegram_identity', { ok: r.ok });
      say(r.ok ? `Hotovo: tento Telegram účet je propojený s účtem ClearSpace „${clean(r.name, 80) || 'uživatel'}". Pokud jste to nebyli vy, odpojte ho v ClearSpace → Nastavení.`
        : 'Kód je neplatný nebo vypršel. Vytvořte nový v ClearSpace → Nastavení → Slack a Telegram pro projekty.');
    } else {
      say(HELP_PRIVATE);
    }
    return replies;                                // private chats are never stored
  }
  if (type !== 'group' && type !== 'supergroup') return replies;

  if (cmd) {
    if (cmd.cmd === 'link') {
      const code = normCode(cmd.args);
      if (!/^[A-Z0-9]{10}$/.test(code)) { say(`Zadejte kód z ClearSpace: /link@${tg.botUsername} KÓD`, m.message_id); return replies; }
      const admin = await telegramIsGroupAdmin(tg, chat, from.id);
      if (admin === null) throw new HttpError(503, 'telegram unavailable', 'telegram_unavailable');      // retry later
      if (!admin) {
        // the code is now visible to the whole group: burn it so nobody can copy it into another group (RUN 07B review R6)
        await svc(db, cfg, 'hub_svc_burn_code', { p_code_hash: sha256hex(code), p_provider: 'telegram' });
        say('Skupinu může propojit jen její zakladatel nebo správce. Kód byl zneplatněn – správce projektu vytvoří nový.', m.message_id);
        return replies;
      }
      const id = await svc<string>(db, cfg, 'hub_svc_new_id', {});
      const r = await svc<{ ok: boolean; reason?: string; projectName?: string }>(db, cfg, 'hub_svc_link_destination', {
        p_id: id, p_code_hash: sha256hex(code), p_provider: 'telegram', p_ext_key: k.tgChat(chat), p_ext_ref_enc: sealRef(cfg, 'destination', id, { chatId: chat }),
        p_label: clean(m.chat?.title, 100) || 'Telegram skupina', p_kind: type === 'supergroup' ? 'telegram_supergroup' : 'telegram_group', p_installation: null,
        p_linked_by: `Telegram: ${from.username ? `@${clean(from.username, 40)}` : clean(from.first_name, 60) || 'správce skupiny'}`,
      });
      hubLog('telegram_link', { ok: r.ok, reason: r.reason ?? null });
      say(r.ok ? `Skupina čeká na potvrzení v ClearSpace (projekt „${clean(r.projectName, 120)}"). Dokud ji správce projektu nepotvrdí, ClearSpace sem nic nepíše a nic odsud neukládá.`
        : LINK_REASON[r.reason ?? ''] ?? 'Propojení se nepodařilo.', m.message_id);
      return replies;
    }
    if (cmd.cmd === 'task') {
      const src: Msg | undefined = m.reply_to_message;
      if (!src || !Number.isSafeInteger(src.message_id)) { say(`Pošlete /task@${tg.botUsername} jako odpověď na zprávu, ze které má vzniknout úkol.`, m.message_id); return replies; }
      const d = await resolve(chat);
      if (!d) { say('Tato skupina není propojená s žádným projektem ClearSpace.', m.message_id); return replies; }
      const srcText = String(src.text ?? src.caption ?? '').slice(0, 4000);
      const title = clean(cmd.args, 200) || clean(srcText.split('\n')[0], 150) || 'Úkol z Telegramu';
      const r = await svc<{ ok: boolean; reason?: string; duplicate?: boolean; cardId?: string; projectId?: string; title?: string; projectName?: string }>(db, cfg, 'hub_svc_create_task', {
        p_destination: d.id, p_ext_user: k.tgUser(from.id), p_title: title, p_details: srcText, p_msg_key: k.tgMsg(chat, src.message_id),
        p_author_label: src.from?.is_bot ? 'Bot' : `Telegram: ${clean(src.from?.first_name, 60) || 'člen skupiny'}`, p_text: srcText,
        p_permalink: telegramMessageLink(chat, src.message_id), p_sent_at: Number.isSafeInteger(src.date) ? new Date(src.date * 1000).toISOString() : null,
      });
      hubLog('telegram_task', { ok: r.ok, reason: r.reason ?? null, duplicate: r.duplicate ?? false });
      if (!r.ok) { say(TASK_REASON[r.reason ?? ''] ?? 'Úkol se nepodařilo vytvořit.', m.message_id); return replies; }
      say(`${r.duplicate ? 'Úkol už existuje' : 'Vytvořen úkol'} v ClearSpace: „${clean(r.title, 150)}" (${clean(r.projectName, 80)})\n${taskHref(cfg.appBaseUrl, r.projectId ?? d.projectId, r.cardId)}${r.duplicate ? '' : '\nOdpovědi na tuto zprávu se propíší jako komentáře k úkolu.'}`,
        src.message_id,
        r.duplicate ? undefined : async (sent) => {
          if (sent.ref) await svc(db, cfg, 'hub_svc_attach_conversation', { p_destination: d.id, p_card: r.cardId, p_thread_key: k.tgThread(chat, Number(sent.ref)), p_thread_ref: sent.ref });
        });
      return replies;
    }
    if (cmd.cmd === 'ucet') { say('Účet propojíte v ClearSpace → Nastavení → Slack a Telegram pro projekty → Propojit Telegram.', m.message_id); return replies; }
    if (cmd.cmd === 'stav') {
      const d = await resolve(chat);
      say(d ? `Projekt „${clean(d.projectName, 120)}" – ${d.status === 'active' ? 'aktivní' : d.status === 'pending' ? 'čeká na potvrzení' : d.status}. Oznámení: ${d.notify ? 'ano' : 'ne'}, úkoly z chatu: ${d.interactive ? 'ano' : 'ne'}, Project Intelligence: ${d.intelligence ? (d.fullIngest ? 'ano – celá skupina (PI bot)' : 'ano – jen zprávy pro bota') : 'ne'}.`
        : 'Tato skupina není propojená s žádným projektem ClearSpace.', m.message_id);
      return replies;
    }
    if (cmd.cmd === 'help' || cmd.cmd === 'start') { say(HELP_GROUP(tg.botUsername), m.message_id); return replies; }
    return replies;
  }

  // a plain message the project bot received: with privacy mode on only a REPLY to one of its messages (or anything, if it is a group admin)
  const d = await resolve(chat);
  if (!d || d.status !== 'active') return replies;
  const replyToBot = m.reply_to_message?.from?.is_bot && String(m.reply_to_message.from.username ?? '').toLowerCase() === tg.botUsername.toLowerCase();
  // "selected" ingestion only: what was addressed to the bot. Full-group ingestion is the PI bot's job (never the project bot's).
  const ingest = d.intelligence && hubIntelligenceEnabled() && replyToBot;
  if (!(replyToBot && d.interactive) && !ingest) return replies;
  const r = await svc<{ outcome: string; kind?: string; commentId?: string | null }>(db, cfg, 'hub_svc_inbound_message', {
    p_destination: d.id, p_thread_key: replyToBot ? k.tgThread(chat, Number(m.reply_to_message.message_id)) : null, p_msg_key: k.tgMsg(chat, Number(m.message_id)),
    p_ext_user: k.tgUser(from.id), p_author_label: `Telegram: ${clean(from.first_name, 60) || 'člen skupiny'}`, p_text: String(m.text ?? m.caption ?? '').slice(0, 4000),
    p_permalink: telegramMessageLink(chat, Number(m.message_id)), p_sent_at: Number.isSafeInteger(m.date) ? new Date(m.date * 1000).toISOString() : null, p_ingest_allowed: ingest,
  });
  hubLog('telegram_message', { outcome: r.outcome, kind: r.kind ?? null, comment: Boolean(r.commentId) });
  return replies;
}

// ------------------------------------------------------------------ optional Project Intelligence bot (privacy mode OFF, read-only)
async function handleTelegramPi({ cfg, db }: Ctx, tg: HubTelegram, u: Msg): Promise<Reply[]> {
  if (!hubIntelligenceEnabled()) return [];                               // kill switch: nothing is even resolved
  const m: Msg | undefined = u.message ?? u.edited_message;
  if (!m || (m.chat?.type !== 'group' && m.chat?.type !== 'supergroup') || m.from?.is_bot) return [];   // never private chats
  const chat = Number(m.chat?.id);
  if (!Number.isSafeInteger(chat) || !Number.isSafeInteger(m.message_id)) return [];
  const k = keys(cfg.routingKey);
  const d = await svc<ResolvedDestination | null>(db, cfg, 'hub_svc_resolve', { p_provider: 'telegram', p_ext_key: k.tgChat(chat) });
  // only a CONFIRMED destination whose manager switched on full-group ingestion; any other group the bot sits in is ignored entirely
  if (!d || d.status !== 'active' || !d.intelligence || !d.fullIngest) return [];
  const text = String(m.text ?? m.caption ?? '').slice(0, 4000);
  if (!text.trim() || text.startsWith('/')) return [];
  // replies to the PROJECT bot belong to task conversations: the project bot handles them (else they would become plain imports, no comment)
  if (String(m.reply_to_message?.from?.username ?? '').toLowerCase() === tg.botUsername.toLowerCase()) return [];
  if (u.edited_message) {
    await svc(db, cfg, 'hub_svc_message_changed', { p_destination: d.id, p_msg_key: k.tgMsg(chat, Number(m.message_id)), p_text: text, p_deleted: false });
    return [];
  }
  const r = await svc<{ outcome: string }>(db, cfg, 'hub_svc_inbound_message', {
    p_destination: d.id, p_thread_key: null, p_msg_key: k.tgMsg(chat, Number(m.message_id)), p_ext_user: k.tgUser(Number(m.from?.id ?? 0)),
    p_author_label: `Telegram: ${clean(m.from?.first_name, 60) || 'člen skupiny'}`, p_text: text, p_permalink: telegramMessageLink(chat, Number(m.message_id)),
    p_sent_at: Number.isSafeInteger(m.date) ? new Date(m.date * 1000).toISOString() : null, p_ingest_allowed: true,
  });
  hubLog('telegram_pi_message', { outcome: r.outcome });
  return [];
}
