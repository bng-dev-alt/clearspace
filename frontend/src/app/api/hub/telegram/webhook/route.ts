import { NextRequest, NextResponse } from 'next/server';
import { HttpError } from '../../../../../lib/collab/invitationServer';
import { randomToken, sha256hex } from '../../../../../lib/google/crypto';
import { hubIntelligenceEnabled, type HubConfig, type HubTelegram } from '../../../../../lib/hub/config';
import { taskHref } from '../../../../../lib/hub/dispatch';
import { parseCommand, telegramIsGroupAdmin, telegramMessageLink, telegramPost } from '../../../../../lib/hub/providers';
import {
  hubLog, identityLink, keys, LINK_REASON, normCode, readRaw, requireHubTelegram, sealRef, serviceDb, svc, TASK_REASON, verifyTelegram,
  type ResolvedDestination,
} from '../../../../../lib/hub/server';
import { clean } from '../../../../../lib/notify/message';
import type { SupabaseClient } from '@supabase/supabase-js';

export const maxDuration = 30;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Msg = Record<string, any>;
const HELP_GROUP = (bot: string) => [
  'ClearSpace – příkazy ve skupině:',
  `• /link@${bot} KÓD – propojí skupinu s projektem (jen správce skupiny; kód vytvoří správce projektu v ClearSpace → Projekt → Integrace)`,
  `• /task@${bot} [název] – jako odpověď na zprávu vytvoří úkol (účet musíte mít propojený)`,
  `• Odpovědi na potvrzení úkolu od bota se propisují jako komentáře k úkolu.`,
  `• Propojení účtu: napište mi soukromě /start`,
  'Bot vidí jen příkazy a odpovědi na své zprávy (režim soukromí Telegramu je zapnutý).',
].join('\n');
const HELP_PRIVATE = 'ClearSpace – projektový bot.\n/start – propojí váš Telegram účet s ClearSpace (odkaz platí 10 minut).\nSoukromé zprávy se nikam neukládají.';

/**
 * POST /api/hub/telegram/webhook -- updates of the PROJECT bot (official Bot API webhook, secret header; update_id dedupe). Privacy mode stays
 * ON: in groups the bot receives only commands addressed to it, replies to its own messages and service messages. Private chats are used
 * only to link a ClearSpace account and are never stored.
 */
export async function POST(req: NextRequest) {
  try {
    const { cfg, telegram } = requireHubTelegram();
    if (!verifyTelegram(telegram.webhookSecret, req.headers)) { hubLog('telegram_bad_secret'); return new NextResponse(null, { status: 401 }); }
    let u: Record<string, any>;
    try { u = JSON.parse(await readRaw(req)); } catch { return new NextResponse(null, { status: 400 }); }
    if (!Number.isSafeInteger(u.update_id)) return new NextResponse(null, { status: 200 });
    const db = await serviceDb(cfg);
    if (!await svc<boolean>(db, cfg, 'hub_svc_inbox', { p_provider: 'telegram', p_event_key: `u:${u.update_id}` })) {
      hubLog('telegram_update_duplicate');
      return new NextResponse(null, { status: 200 });
    }
    try {
      await handle(cfg, telegram, db, u);
    } catch (err) {
      // at most once: the update is recorded; a failure is logged (code only) and not retried by Telegram
      hubLog('telegram_update_error', { code: err instanceof HttpError ? err.code : 'error' });
    }
    return new NextResponse(null, { status: 200 });
  } catch (err) {
    hubLog('telegram_webhook_error', { code: err instanceof HttpError ? err.code : 'error' });
    if (err instanceof HttpError && err.status === 503) return NextResponse.json({ error: err.code }, { status: 503 });
    return new NextResponse(null, { status: 500 });
  }
}

async function handle(cfg: HubConfig, tg: HubTelegram, db: SupabaseClient, u: Record<string, any>) {
  const k = keys(cfg.serverSecret);
  const resolve = (chat: number) => svc<ResolvedDestination | null>(db, cfg, 'hub_svc_resolve', { p_provider: 'telegram', p_ext_key: k.tgChat(chat) });

  // the bot was removed from / added back to a group
  if (u.my_chat_member) {
    const chat = Number(u.my_chat_member.chat?.id), st = String(u.my_chat_member.new_chat_member?.status ?? '');
    if (!Number.isSafeInteger(chat)) return;
    const d = await resolve(chat);
    if (!d || d.status === 'pending') return;
    if ((st === 'left' || st === 'kicked') && d.status === 'active') await svc(db, cfg, 'hub_svc_destination_state', { p_destination: d.id, p_status: 'removed_bot', p_error: 'telegram_bot_removed' });
    if ((st === 'member' || st === 'administrator') && d.status === 'removed_bot') await svc(db, cfg, 'hub_svc_destination_state', { p_destination: d.id, p_status: 'active', p_error: null });
    hubLog('telegram_membership', { status: st });
    return;
  }

  if (u.edited_message) {
    const m: Msg = u.edited_message, chat = Number(m.chat?.id);
    if (!Number.isSafeInteger(chat) || m.chat?.type === 'private' || m.from?.is_bot) return;
    const d = await resolve(chat);
    if (d?.status === 'active') {
      await svc(db, cfg, 'hub_svc_message_changed', { p_destination: d.id, p_msg_key: k.tgMsg(chat, Number(m.message_id)), p_text: String(m.text ?? m.caption ?? '').slice(0, 4000), p_deleted: false });
    }
    return;
  }

  const m: Msg | undefined = u.message;
  if (!m) return;
  const chat = Number(m.chat?.id), type = String(m.chat?.type ?? ''), from: Msg = m.from ?? {};
  if (!Number.isSafeInteger(chat)) return;
  const say = (text: string, replyTo?: number) => telegramPost(tg, chat, text, replyTo);

  // a group became a supergroup: same binding, new chat id
  if (Number.isSafeInteger(m.migrate_to_chat_id)) {
    const d = await resolve(chat);
    if (d) {
      const moved = await svc<boolean>(db, cfg, 'hub_svc_migrate', { p_old_key: k.tgChat(chat), p_new_key: k.tgChat(m.migrate_to_chat_id),
        p_new_ref_enc: sealRef(cfg, 'destination', d.id, { chatId: m.migrate_to_chat_id }), p_destination: d.id });
      hubLog('telegram_migrated', { moved });
    }
    return;
  }
  if (from.is_bot || !Number.isSafeInteger(from.id)) return;
  const text = String(m.text ?? '');
  const cmd = text.startsWith('/') ? parseCommand(text, tg.botUsername) : null;

  if (type === 'private') {
    if (cmd?.cmd === 'start' || cmd?.cmd === 'ucet') {
      const code = randomToken(32);
      const label = `Telegram: ${from.username ? `@${clean(from.username, 40)}` : clean(from.first_name, 60) || 'účet'}`;
      await svc(db, cfg, 'hub_svc_identity_begin', { p_code_hash: sha256hex(code), p_provider: 'telegram', p_ext_user: k.tgUser(from.id), p_label: label });
      hubLog('telegram_identity_begin');
      await say(`Propojte svůj Telegram účet s ClearSpace (odkaz platí 10 minut, nikomu ho neposílejte):\n${identityLink(cfg, code)}`);
    } else {
      await say(HELP_PRIVATE);
    }
    return;                                     // private chats are never stored
  }
  if (type !== 'group' && type !== 'supergroup') return;

  if (cmd) {
    if (cmd.cmd === 'link') {
      const code = normCode(cmd.args);
      if (!/^[A-Z0-9]{10}$/.test(code)) { await say(`Zadejte kód z ClearSpace: /link@${tg.botUsername} KÓD`, m.message_id); return; }
      const admin = await telegramIsGroupAdmin(tg, chat, from.id);
      if (admin !== true) { await say(admin === null ? 'Oprávnění se nepodařilo ověřit. Zkuste to prosím znovu.' : 'Skupinu může propojit jen její zakladatel nebo správce.', m.message_id); return; }
      const id = await svc<string>(db, cfg, 'hub_svc_new_id', {});
      const r = await svc<{ ok: boolean; reason?: string; projectName?: string }>(db, cfg, 'hub_svc_link_destination', {
        p_id: id, p_code_hash: sha256hex(code), p_provider: 'telegram', p_ext_key: k.tgChat(chat), p_ext_ref_enc: sealRef(cfg, 'destination', id, { chatId: chat }),
        p_label: clean(m.chat?.title, 100) || 'Telegram skupina', p_kind: type === 'supergroup' ? 'telegram_supergroup' : 'telegram_group', p_installation: null,
      });
      hubLog('telegram_link', { ok: r.ok, reason: r.reason ?? null });
      await say(r.ok ? `Skupina čeká na potvrzení v ClearSpace (projekt „${clean(r.projectName, 120)}"). Dokud ji správce projektu nepotvrdí, ClearSpace sem nic nepíše a nic odsud neukládá.`
        : LINK_REASON[r.reason ?? ''] ?? 'Propojení se nepodařilo.', m.message_id);
      return;
    }
    if (cmd.cmd === 'task') {
      const src: Msg | undefined = m.reply_to_message;
      if (!src || !Number.isSafeInteger(src.message_id)) { await say(`Pošlete /task@${tg.botUsername} jako odpověď na zprávu, ze které má vzniknout úkol.`, m.message_id); return; }
      const d = await resolve(chat);
      if (!d) { await say('Tato skupina není propojená s žádným projektem ClearSpace.', m.message_id); return; }
      const srcText = String(src.text ?? src.caption ?? '').slice(0, 4000);
      const title = clean(cmd.args, 200) || clean(srcText.split('\n')[0], 150) || 'Úkol z Telegramu';
      const r = await svc<{ ok: boolean; reason?: string; duplicate?: boolean; cardId?: string; projectId?: string; title?: string; projectName?: string }>(db, cfg, 'hub_svc_create_task', {
        p_destination: d.id, p_ext_user: k.tgUser(from.id), p_title: title, p_details: srcText, p_msg_key: k.tgMsg(chat, src.message_id),
        p_author_label: src.from?.is_bot ? 'Bot' : `Telegram: ${clean(src.from?.first_name, 60) || 'člen skupiny'}`, p_text: srcText,
        p_permalink: telegramMessageLink(chat, src.message_id), p_sent_at: Number.isSafeInteger(src.date) ? new Date(src.date * 1000).toISOString() : null,
      });
      hubLog('telegram_task', { ok: r.ok, reason: r.reason ?? null, duplicate: r.duplicate ?? false });
      if (!r.ok) { await say(TASK_REASON[r.reason ?? ''] ?? 'Úkol se nepodařilo vytvořit.', m.message_id); return; }
      const sent = await say(`${r.duplicate ? 'Úkol už existuje' : 'Vytvořen úkol'} v ClearSpace: „${clean(r.title, 150)}" (${clean(r.projectName, 80)})\n${taskHref(cfg.appBaseUrl, r.projectId ?? d.projectId, r.cardId)}\nOdpovědi na tuto zprávu se propíší jako komentáře k úkolu.`, src.message_id);
      if (!r.duplicate && sent.ref) {
        await svc(db, cfg, 'hub_svc_attach_conversation', { p_destination: d.id, p_card: r.cardId, p_thread_key: k.tgThread(chat, Number(sent.ref)), p_thread_ref: sent.ref });
      }
      return;
    }
    if (cmd.cmd === 'ucet') { await say(`Účet propojíte v soukromé zprávě: https://t.me/${tg.botUsername}?start=ucet`, m.message_id); return; }
    if (cmd.cmd === 'stav') {
      const d = await resolve(chat);
      await say(d ? `Projekt „${clean(d.projectName, 120)}" – ${d.status === 'active' ? 'aktivní' : d.status === 'pending' ? 'čeká na potvrzení' : d.status}. Oznámení: ${d.notify ? 'ano' : 'ne'}, úkoly z chatu: ${d.interactive ? 'ano' : 'ne'}, Project Intelligence: ${d.intelligence ? 'ano' : 'ne'}.`
        : 'Tato skupina není propojená s žádným projektem ClearSpace.', m.message_id);
      return;
    }
    if (cmd.cmd === 'help' || cmd.cmd === 'start') { await say(HELP_GROUP(tg.botUsername), m.message_id); return; }
    return;
  }

  // a plain message the bot received: a reply to one of its messages (privacy mode), or anything if the bot is a group admin
  const d = await resolve(chat);
  if (!d || d.status !== 'active') return;
  const replyToBot = m.reply_to_message?.from?.is_bot && String(m.reply_to_message.from.username ?? '').toLowerCase() === tg.botUsername.toLowerCase();
  const ingest = d.intelligence && hubIntelligenceEnabled();
  if (!(replyToBot && d.interactive) && !ingest) return;
  const r = await svc<{ outcome: string; kind?: string; commentId?: string | null }>(db, cfg, 'hub_svc_inbound_message', {
    p_destination: d.id, p_thread_key: replyToBot ? k.tgThread(chat, Number(m.reply_to_message.message_id)) : null, p_msg_key: k.tgMsg(chat, Number(m.message_id)),
    p_ext_user: k.tgUser(from.id), p_author_label: `Telegram: ${clean(from.first_name, 60) || 'člen skupiny'}`, p_text: String(m.text ?? m.caption ?? '').slice(0, 4000),
    p_permalink: telegramMessageLink(chat, Number(m.message_id)), p_sent_at: Number.isSafeInteger(m.date) ? new Date(m.date * 1000).toISOString() : null, p_ingest_allowed: ingest,
  });
  hubLog('telegram_message', { outcome: r.outcome, kind: r.kind ?? null, comment: Boolean(r.commentId) });
}
