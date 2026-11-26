-- Communication hub hardening (20261201001700). AUTOCOMMIT: each DO block = one committed request. Synthetic data.
-- a = owner, b = editor, s = service principal. Runs after 96 in the harness (own users/projects, own trust row).
\set ON_ERROR_STOP 1

DO $$
DECLARE a uuid; b uuid; s uuid;
BEGIN
  a := test.mkuser('hh-own@example.test'); b := test.mkuser('hh-ed@example.test'); s := test.mkuser('hh-service@example.test');
  PERFORM set_config('t.a', a::text, false); PERFORM set_config('t.b', b::text, false); PERFORM set_config('t.s', s::text, false);
  INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('hub', encode(sha256(convert_to(repeat('k', 40), 'UTF8')), 'hex'))
  ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;
  INSERT INTO public.hub_service_principal (singleton, user_id) VALUES (true, s) ON CONFLICT (singleton) DO UPDATE SET user_id = EXCLUDED.user_id;
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'hh-own@example.test');
  INSERT INTO public.projects (id, name) VALUES ('hh1', 'Hardening');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('hh1-todo', 'hh1', 'K udělání', 0), ('hh1-done', 'hh1', 'Hotovo', 1);
  INSERT INTO public.project_members (project_id, member_id) VALUES ('hh1', 'member-owner-' || current_setting('t.a'));
  SELECT * INTO r FROM public.create_project_invitation('hh1', 'hh-ed@example.test', 'member'); PERFORM set_config('t.tb', r.token, false);
  PERFORM public.hub_link_begin(repeat('k', 40), 'hh1', 'telegram', encode(sha256('hh-code'), 'hex'));
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'hh-ed@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tb'), 'Editor Bára'); END $$;

-- ================= replay-safe linking =================
DO $$
DECLARE r jsonb; r2 jsonb;
BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  r := public.hub_svc_link_destination(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', encode(sha256('hh-code'), 'hex'), 'telegram', repeat('7', 64), 'v1.0000beef.aaaa.bbbb.cccc', 'Skupina', 'telegram_supergroup', null);
  r2 := public.hub_svc_link_destination(repeat('k', 40), '00000000-0000-4000-8000-0000000000e9', encode(sha256('hh-code'), 'hex'), 'telegram', repeat('7', 64), 'v1.0000beef.aaaa.bbbb.cccc', 'Skupina', 'telegram_supergroup', null);
  PERFORM test.ok((r ->> 'ok')::boolean AND (r2 ->> 'replay')::boolean AND r2 ->> 'destinationId' = r ->> 'destinationId', 'a replayed link (crash + provider retry) answers the same, creates nothing');
  r2 := public.hub_svc_link_destination(repeat('k', 40), '00000000-0000-4000-8000-0000000000ea', encode(sha256('hh-code'), 'hex'), 'telegram', repeat('8', 64), 'v1.0000beef.aaaa.bbbb.cccc', 'Jiná', 'telegram_group', null);
  PERFORM test.ok(r2 ->> 'reason' = 'code_invalid', 'the consumed code cannot link ANOTHER chat');
  PERFORM test.reset();
  PERFORM test.ok((SELECT count(*) FROM public.hub_destinations WHERE project_id = 'hh1') = 1, 'exactly one destination');
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'hh-own@example.test');
  PERFORM test.throws($q$select public.hub_destination_configure(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', true, true, false, false, ARRAY['task_created'])$q$, '22023', 'a pending destination cannot be configured');
  PERFORM public.hub_destination_decide(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', true);
  PERFORM public.hub_destination_configure(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', true, true, false, false, ARRAY['task_created']);
END $$;

-- ================= full-group ingestion (optional PI bot): opt-in, acknowledged, Telegram only, needs PI =================
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'hh-own@example.test');
  PERFORM public.hub_destination_configure(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', true, true, false, false, ARRAY['task_created'], true);
  PERFORM test.ok(NOT (SELECT full_ingest FROM public.hub_destinations WHERE id = '00000000-0000-4000-8000-0000000000e1'), 'full ingestion without PI stays off');
  PERFORM public.hub_destination_configure(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', true, true, true, true, ARRAY['task_created'], false);
  PERFORM test.throws($q$select public.hub_destination_configure(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', true, true, true, false, ARRAY['task_created'], true)$q$, '22023', 'turning full ingestion on needs its own acknowledgement');
  PERFORM public.hub_destination_configure(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', true, true, true, true, ARRAY['task_created'], true);
  PERFORM test.reset();
  PERFORM test.ok((SELECT full_ingest AND intelligence_confirmed_by = current_setting('t.a')::uuid FROM public.hub_destinations WHERE id = '00000000-0000-4000-8000-0000000000e1'), 'full ingestion on, confirmation recorded');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'hh-own@example.test');
  PERFORM test.ok((public.hub_project_status(repeat('k', 40), 'hh1') -> 'destinations' -> 0 ->> 'fullIngest')::boolean, 'status shows the scope');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'hh-ed@example.test');
  PERFORM test.ok((SELECT full_ingest FROM public.hub_destinations WHERE project_id = 'hh1'), 'members see the scope flag (honest UI)');
  PERFORM test.throws($q$select public.hub_destination_configure(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', true, true, false, false, ARRAY['task_created'])$q$, '42501', 'an editor cannot change it');
END $$;
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  r := public.hub_svc_inbound_message(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', null, repeat('a', 64), repeat('f', 64), 'Telegram: X', 'Obecná zpráva skupiny', null, now(), true);
  PERFORM test.ok(r ->> 'kind' = 'ingested', 'PI ingestion stores the group message');
  PERFORM test.ok(public.hub_svc_message_permalink(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', repeat('a', 64), 'https://t.me/c/1/2'), 'permalink attached afterwards');
  PERFORM test.ok(NOT public.hub_svc_message_permalink(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', repeat('a', 64), 'https://t.me/c/1/3'), 'an existing permalink is never replaced');
  PERFORM test.ok(NOT public.hub_svc_message_permalink(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', repeat('a', 64), 'javascript:alert(1)'), 'only https links');
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'hh-own@example.test');
  PERFORM public.hub_destination_configure(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', true, true, false, false, ARRAY['task_created']);
  PERFORM test.ok((SELECT count(*) FROM public.hub_messages WHERE project_id = 'hh1' AND kind = 'ingested') = 0, 'A23: switching PI off DELETES what was imported for it');
  PERFORM test.ok(NOT (SELECT full_ingest FROM public.hub_destinations WHERE id = '00000000-0000-4000-8000-0000000000e1'), 'and full ingestion with it');
END $$;

-- ================= concurrency-safe task creation (same source message twice) =================
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'hh-ed@example.test');
  PERFORM public.hub_identity_begin(repeat('k', 40), 'telegram', encode(sha256('hh-id'), 'hex'));
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM public.hub_svc_identity_complete(repeat('k', 40), encode(sha256('hh-id'), 'hex'), 'telegram', repeat('b', 64), 'Bára');
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM public.hub_svc_create_task(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', repeat('b', 64), 'Úkol', '', repeat('c', 64), 'X', 't', null, now());
END $$;
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  r := public.hub_svc_create_task(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', repeat('b', 64), 'Úkol', '', repeat('c', 64), 'X', 't', null, now());
  PERFORM test.ok((r ->> 'duplicate')::boolean, 'the same source message never makes a second task');
  PERFORM test.reset();
  PERFORM test.ok((SELECT count(*) FROM public.cards WHERE project_id = 'hh1') = 1, 'one card');
END $$;

-- ================= durable inbox: receive / claim / replying / done / retry / exhaustion =================
DO $$
DECLARE r jsonb; c jsonb; c2 jsonb;
BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  r := public.hub_svc_inbox_receive(repeat('k', 40), 'telegram', 'u:hh1', '{"update_id": 1}'::jsonb);
  PERFORM test.ok((r ->> 'new')::boolean AND r ->> 'status' = 'received', 'a new event is stored as received with its payload');
  PERFORM test.ok(NOT (public.hub_svc_inbox_receive(repeat('k', 40), 'telegram', 'u:hh1', '{"update_id": 1}'::jsonb) ->> 'new')::boolean, 'a provider retry is recognised');
  PERFORM set_config('t.i1', r ->> 'id', false);
  c := public.hub_svc_inbox_claim(repeat('k', 40), (r ->> 'id')::uuid, 60);
  c2 := public.hub_svc_inbox_claim(repeat('k', 40), (r ->> 'id')::uuid, 60);
  PERFORM test.ok(c ->> 'payload' IS NOT NULL AND (c ->> 'attempt')::int = 1, 'claimed with its payload');
  PERFORM test.ok(c2 IS NULL, 'a second worker cannot claim a leased event');
  PERFORM test.ok(public.hub_svc_inbox_done(repeat('k', 40), (r ->> 'id')::uuid, 'retry', 'db') = 'retry', 'retryable failure -> retry with backoff');
  PERFORM test.ok(public.hub_svc_inbox_claim(repeat('k', 40), (r ->> 'id')::uuid, 60) IS NULL, 'not due before the backoff');
END $$;
DO $$
DECLARE i uuid := current_setting('t.i1')::uuid;
BEGIN
  UPDATE public.hub_inbox SET next_attempt_at = now() - interval '1 second' WHERE id = i;
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM test.ok(i = ANY (public.hub_svc_inbox_due(repeat('k', 40), 10)), 'due work is handed to the dispatcher');
  PERFORM test.ok((public.hub_svc_inbox_claim(repeat('k', 40), i, 60) ->> 'attempt')::int = 2, 'second attempt');
  PERFORM test.ok(public.hub_svc_inbox_replying(repeat('k', 40), i), 'effects done -> replying');
  PERFORM test.reset();
  PERFORM test.ok((SELECT payload IS NULL FROM public.hub_inbox WHERE id = i), 'payload dropped before replies are sent');
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM test.ok(public.hub_svc_inbox_done(repeat('k', 40), i, 'retry', 'reply_failed') = 'completed', 'a failure after replies began is NEVER retried (at most once outbound)');
  PERFORM test.ok(public.hub_svc_inbox_claim(repeat('k', 40), i, 60) IS NULL, 'a completed event cannot be claimed again');
END $$;
-- crash during processing: the lease expires, another worker takes over; after 5 attempts terminal failure
DO $$
DECLARE r jsonb; i uuid;
BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  r := public.hub_svc_inbox_receive(repeat('k', 40), 'slack', 'e:hh2', '{"x": 1}'::jsonb); i := (r ->> 'id')::uuid;
  PERFORM public.hub_svc_inbox_claim(repeat('k', 40), i, 60);
  PERFORM test.reset();
  UPDATE public.hub_inbox SET lease_until = now() - interval '1 second' WHERE id = i;
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM test.ok(i = ANY (public.hub_svc_inbox_due(repeat('k', 40), 10)), 'an expired lease (crashed worker) is due again');
  PERFORM test.ok((public.hub_svc_inbox_claim(repeat('k', 40), i, 60) ->> 'attempt')::int = 2, 'taken over by another worker');
  PERFORM test.reset();
  UPDATE public.hub_inbox SET attempts = 5, status = 'retry', next_attempt_at = now() - interval '1 second', lease_until = NULL WHERE id = i;
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM test.ok(public.hub_svc_inbox_claim(repeat('k', 40), i, 60) IS NULL, 'retry budget exhausted');
  PERFORM test.reset();
  PERFORM test.ok((SELECT status = 'failed' AND payload IS NULL AND last_error_code IS NOT NULL FROM public.hub_inbox WHERE id = i), 'terminal failure keeps no payload');
END $$;
-- a stale reply (worker died while sending) is closed by the scheduler without re-sending
DO $$
DECLARE r jsonb; i uuid;
BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  r := public.hub_svc_inbox_receive(repeat('k', 40), 'telegram', 'u:hh3', '{"x": 1}'::jsonb); i := (r ->> 'id')::uuid;
  PERFORM set_config('t.i3', i::text, false);
  PERFORM public.hub_svc_inbox_claim(repeat('k', 40), i, 60);
  PERFORM public.hub_svc_inbox_replying(repeat('k', 40), i);
END $$;
DO $$
DECLARE i uuid := current_setting('t.i3')::uuid;
BEGIN
  UPDATE public.hub_inbox SET lease_until = now() - interval '1 second' WHERE id = i;
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM test.ok(NOT (i = ANY (public.hub_svc_inbox_due(repeat('k', 40), 10))), 'a stale reply is never handed out for processing');
  PERFORM test.reset();
  PERFORM public.hub_dispatch_prepare();
  PERFORM test.ok((SELECT status = 'completed' AND last_error_code = 'reply_ambiguous' FROM public.hub_inbox WHERE id = i), 'scheduler closes it as reply_ambiguous');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'hh-own@example.test');
  PERFORM test.throws($q$select public.hub_svc_inbox_claim(repeat('k', 40), '00000000-0000-4000-8000-000000000000', 60)$q$, '42501', 'inbox RPCs are service-only');
  PERFORM test.throws('select * from public.hub_inbox', '42501', 'clients cannot read the inbox (payloads)');
END $$;

-- ================= re-check after the bot was added back =================
DO $$ BEGIN
  UPDATE public.hub_destinations SET status = 'removed_bot', last_error_code = 'telegram_forbidden' WHERE id = '00000000-0000-4000-8000-0000000000e1';
  PERFORM test.act_as(current_setting('t.a')::uuid, 'hh-own@example.test');
  PERFORM public.hub_destination_mark_user(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', 'active', null);
  PERFORM test.ok((SELECT status FROM public.hub_destinations WHERE id = '00000000-0000-4000-8000-0000000000e1') = 'removed_bot', 'no re-activation without a fresh proven send');
  PERFORM test.ok(public.hub_destination_target(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1') ->> 'status' = 'removed_bot', 're-check is allowed for a cut-off destination');
  PERFORM public.hub_destination_mark_user(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', 'active', null);
  PERFORM test.reset();
  PERFORM test.ok((SELECT status = 'active' AND last_error_code IS NULL FROM public.hub_destinations WHERE id = '00000000-0000-4000-8000-0000000000e1'), 'a successful re-check re-activates it');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'hh-ed@example.test');
  PERFORM test.throws($q$select public.hub_destination_target(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1')$q$, '42501', 'editors cannot re-check');
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM test.throws($q$select public.hub_identity_confirm(repeat('k', 40), 'x')$q$, '42883', 'the RUN 07 chat-initiated identity confirmation no longer exists');
END $$;

-- ================= security review fixes (RUN 07B) =================
-- second destination (notify task_created) + a second project of the owner (target of a card move)
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'hh-own@example.test');
  PERFORM public.hub_link_begin(repeat('k', 40), 'hh1', 'telegram', encode(sha256('hh-code2'), 'hex'));
  PERFORM public.hub_link_begin(repeat('k', 40), 'hh1', 'telegram', encode(sha256('hh-code3'), 'hex'));
  INSERT INTO public.projects (id, name) VALUES ('hh2', 'Jiný projekt vlastníka');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('hh2-a', 'hh2', 'A', 0);
  INSERT INTO public.project_members (project_id, member_id) VALUES ('hh2', 'member-owner-' || current_setting('t.a'));
END $$;
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM test.ok(public.hub_svc_burn_code(repeat('k', 40), encode(sha256('hh-code3'), 'hex'), 'telegram'), 'a code exposed by a non-admin attempt is burnt');
  r := public.hub_svc_link_destination(repeat('k', 40), '00000000-0000-4000-8000-0000000000e3', encode(sha256('hh-code3'), 'hex'), 'telegram', repeat('3', 64), 'v1.0000beef.aaaa.bbbb.cccc', 'Kopie', 'telegram_group', null, 'Mallory');
  PERFORM test.ok(r ->> 'reason' = 'code_invalid', 'R6: a burnt code cannot be copied into another group');
  r := public.hub_svc_link_destination(repeat('k', 40), '00000000-0000-4000-8000-0000000000e2', encode(sha256('hh-code2'), 'hex'), 'telegram', repeat('2', 64), 'v1.0000beef.aaaa.bbbb.cccc', 'Druhá skupina', 'telegram_group', null, 'Telegram: Jana');
  PERFORM test.ok((r ->> 'ok')::boolean, 'second group linked');
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'hh-own@example.test');
  PERFORM test.ok((SELECT x ->> 'linkedBy' FROM jsonb_array_elements(public.hub_project_status(repeat('k', 40), 'hh1') -> 'destinations') x WHERE x ->> 'id' = '00000000-0000-4000-8000-0000000000e2') = 'Telegram: Jana',
    'R6: the manager sees WHO typed the code before confirming');
  PERFORM public.hub_destination_decide(repeat('k', 40), '00000000-0000-4000-8000-0000000000e2', true);
  PERFORM public.hub_destination_configure(repeat('k', 40), '00000000-0000-4000-8000-0000000000e2', true, false, false, false, ARRAY['task_created']);
END $$;
-- R8: a task created from chat A is announced in destination B (not echoed into A)
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM set_config('t.r8', public.hub_svc_create_task(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', repeat('b', 64), 'Ohlásit jinde', '', repeat('d', 64), 'X', 't', null, now()) ->> 'cardId', false);
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.hub_outbox WHERE card_id = current_setting('t.r8') AND kind = 'task_created' AND destination_id = '00000000-0000-4000-8000-0000000000e2') = 1, 'R8: the other destination is notified');
  PERFORM test.ok((SELECT count(*) FROM public.hub_outbox WHERE card_id = current_setting('t.r8') AND destination_id = '00000000-0000-4000-8000-0000000000e1') = 0, 'A16: the originating chat is not echoed');
END $$;
-- R9: a thread belongs to its first task (one request per block: impersonation lasts until COMMIT)
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM set_config('t.v1', coalesce(public.hub_svc_attach_conversation(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', current_setting('t.r8'), repeat('9', 64), '501')::text, ''), false);
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  PERFORM set_config('t.c2', public.hub_svc_create_task(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', repeat('b', 64), 'Druhý ze stejného vlákna', '', repeat('e', 64), 'X', 't', null, now()) ->> 'cardId', false);
END $$;
DO $$
DECLARE v2 uuid;
BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  v2 := public.hub_svc_attach_conversation(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', current_setting('t.c2'), repeat('9', 64), '501');
  PERFORM test.ok(current_setting('t.v1') <> '' AND v2 IS NULL, 'R9: a second task from the same thread is not attached to the first task''s conversation');
  PERFORM test.reset();
  PERFORM test.ok((SELECT conversation_id IS NULL FROM public.hub_messages WHERE card_id = current_setting('t.c2')), 'and its record is not mislinked');
END $$;
-- R2: a task moved to another project leaves the channel's conversation
DO $$ BEGIN
  UPDATE public.cards SET project_id = 'hh2', column_id = 'hh2-a' WHERE id = current_setting('t.r8');
END $$;
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM test.act_as(current_setting('t.s')::uuid, 'hh-service@example.test');
  r := public.hub_svc_inbound_message(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', repeat('9', 64), repeat('5', 64), repeat('b', 64), 'Bára', 'Komentář po přesunu', null, now(), false);
  PERFORM test.ok(r ->> 'outcome' = 'dropped', 'R2: replies in the old thread no longer reach the moved task');
  r := public.hub_svc_create_task(repeat('k', 40), '00000000-0000-4000-8000-0000000000e1', repeat('b', 64), 'Ohlásit jinde', '', repeat('d', 64), 'X', 't', null, now());
  PERFORM test.ok(r ->> 'reason' = 'card_moved' AND r ->> 'title' IS NULL, 'R2: the duplicate path does not reveal the moved task');
  PERFORM test.reset();
  PERFORM test.ok((SELECT count(*) FROM public.task_comments WHERE content = 'Komentář po přesunu') = 0, 'no comment in the other project');
END $$;
-- R4 + R7: workspace names of other tenants are not listed; a reinstall does not silently re-activate other projects' channels
DO $$
DECLARE o uuid := test.mkuser('hh-other@example.test');
BEGIN
  INSERT INTO public.hub_slack_installations (team_hmac, team_label, secret_enc, scopes, installed_by)
  VALUES (repeat('6', 64), 'Cizí firma s.r.o.', 'v1.0000beef.aaaa.bbbb.cccc', ARRAY['chat:write'], o);
  PERFORM test.act_as(current_setting('t.a')::uuid, 'hh-own@example.test');
  PERFORM test.ok(NOT (public.hub_project_status(repeat('k', 40), 'hh1') -> 'slackWorkspaces')::text LIKE '%Cizí firma%', 'R4: other tenants'' Slack workspace names stay hidden');
END $$;
DO $$
DECLARE inst uuid;
BEGIN
  SELECT id INTO inst FROM public.hub_slack_installations WHERE team_hmac = repeat('6', 64);
  INSERT INTO public.hub_destinations (project_id, provider, installation_id, ext_key_hmac, ext_ref_enc, label, kind, status)
  VALUES ('hh2', 'slack', inst, repeat('4', 64), 'v1.0000beef.aaaa.bbbb.cccc', '#cizi', 'slack_channel', 'revoked');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'hh-own@example.test');
  PERFORM public.hub_slack_install_begin(repeat('k', 40), encode(sha256('hh-inst'), 'hex'));
  PERFORM public.hub_slack_install_lookup(repeat('k', 40), encode(sha256('hh-inst'), 'hex'), repeat('6', 64));
  PERFORM public.hub_slack_install_store(repeat('k', 40), inst, repeat('6', 64), 'Cizí firma s.r.o.', 'v1.0000beef.aaaa.bbbb.dddd', ARRAY['chat:write']);
  PERFORM test.reset();
  PERFORM test.ok((SELECT status FROM public.hub_destinations WHERE ext_key_hmac = repeat('4', 64)) = 'revoked', 'R7: a reinstall does not re-activate revoked destinations');
END $$;
