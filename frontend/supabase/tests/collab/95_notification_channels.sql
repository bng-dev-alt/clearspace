-- Notifications outside the app (20261129001500). AUTOCOMMIT mode like 90-94: each DO block is one committed transaction (one request),
-- so the deferred RUN 01 triggers (assignments, card events) really fire. Synthetic Czech data only.
-- Roles: a = owner (Slack), b = editor (Telegram), c = viewer (Telegram), d = outsider, e = editor without any channel.
\set ON_ERROR_STOP 1

DO $$
DECLARE a uuid; b uuid; c uuid; d uuid; e uuid;
BEGIN
  a := test.mkuser('n-own@example.test'); b := test.mkuser('n-ed@example.test'); c := test.mkuser('n-view@example.test');
  d := test.mkuser('n-out@example.test'); e := test.mkuser('n-plain@example.test');
  PERFORM set_config('t.a', a::text, false); PERFORM set_config('t.b', b::text, false); PERFORM set_config('t.c', c::text, false);
  PERFORM set_config('t.d', d::text, false); PERFORM set_config('t.e', e::text, false);
  INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('notify', encode(sha256(convert_to(repeat('n', 40), 'UTF8')), 'hex'))
  ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  INSERT INTO public.projects (id, name) VALUES ('n1', 'Rekonstrukce kanceláře'), ('n2', 'Jiný projekt');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('n1-todo', 'n1', 'K udělání', 0), ('n1-done', 'n1', 'Hotovo', 1), ('n2-a', 'n2', 'A', 0);
  INSERT INTO public.project_members (project_id, member_id) VALUES ('n1', 'member-owner-' || current_setting('t.a')), ('n2', 'member-owner-' || current_setting('t.a'));
  INSERT INTO public.cards (id, column_id, title, due_date) VALUES
    ('n1-k1', 'n1-todo', 'Objednat nábytek <!channel> & spol.', '2026-12-10'),
    ('n1-k2', 'n1-todo', 'Revize elektroinstalace', '2027-03-28'),
    ('n1-k3', 'n1-todo', 'Malování', '2027-10-31'),
    ('n2-k1', 'n2-a', 'Cizí úkol', NULL);
  SELECT * INTO r FROM public.create_project_invitation('n1', 'n-ed@example.test', 'member'); PERFORM set_config('t.tb', r.token, false);
  SELECT * INTO r FROM public.create_project_invitation('n1', 'n-view@example.test', 'viewer'); PERFORM set_config('t.tc', r.token, false);
  SELECT * INTO r FROM public.create_project_invitation('n1', 'n-plain@example.test', 'member'); PERFORM set_config('t.te', r.token, false);
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'n-ed@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tb'), 'Editor Eva'); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.c')::uuid, 'n-view@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tc'), 'Čtenář Cyril'); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.e')::uuid, 'n-plain@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.te'), 'Bez kanálu Emil'); END $$;
DO $$ BEGIN
  PERFORM set_config('t.mb', (SELECT id FROM public.workspace_members WHERE profile_id = current_setting('t.b')::uuid AND owner_id = current_setting('t.a')::uuid), false);
  PERFORM set_config('t.mc', (SELECT id FROM public.workspace_members WHERE profile_id = current_setting('t.c')::uuid AND owner_id = current_setting('t.a')::uuid), false);
  PERFORM set_config('t.me', (SELECT id FROM public.workspace_members WHERE profile_id = current_setting('t.e')::uuid AND owner_id = current_setting('t.a')::uuid), false);
  PERFORM test.ok(current_setting('t.mb') <> '' AND current_setting('t.me') <> '', 'setup: invited members are workspace members of the owner');
END $$;

-- ================= nothing for clients; RPCs need the secret; anon only reaches the dispatcher (and only with the secret) =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  PERFORM test.throws('select * from public.notification_channels', '42501', 'authenticated cannot read notification_channels (credentials)');
  PERFORM test.throws('select * from public.notification_preferences', '42501', 'nor notification_preferences');
  PERFORM test.throws('select * from public.notification_deliveries', '42501', 'nor notification_deliveries');
  PERFORM test.throws($q$insert into public.notification_channels (user_id, provider) values (auth.uid(), 'slack')$q$, '42501', 'nor write channels directly');
  PERFORM test.throws($q$select public.notify_status(repeat('x', 40))$q$, '42501', 'notify_status with a wrong secret is refused');
  PERFORM test.throws($q$select public.notify_status(null)$q$, '42501', 'notify_status without the secret is refused');
  PERFORM test.throws($q$select public.notify_enqueue(auth.uid(), 'assignment', 'n:x', null, null, 'n1', null, null)$q$, '42501', 'internal enqueue is not callable by clients');
  PERFORM test.throws($q$select public.notify_prefs_allow(auth.uid(), 'assignment', 'n1')$q$, '42501', 'internal preference check is not callable by clients');
  PERFORM test.throws($q$select * from public.notify_dispatch_claim(10, 60)$q$, '42501', 'the dispatcher is internal: authenticated cannot claim');
  PERFORM test.throws($q$select public.notify_scheduler_tick()$q$, '42501', 'nor run a scheduler tick');
  PERFORM test.throws($q$select public.notify_dispatch_apply('[]'::jsonb)$q$, '42501', 'nor apply results');
  PERFORM test.act_as_anon();
  PERFORM test.throws($q$select public.notify_status(repeat('n', 40))$q$, '42501', 'anon cannot call user RPCs (no EXECUTE)');
  PERFORM test.throws($q$select public.notify_link_begin(repeat('n', 40), 'telegram', repeat('a', 64))$q$, '42501', 'anon cannot begin a link');
  PERFORM test.throws($q$select * from public.notify_dispatch_claim(10, 60)$q$, '42501', 'anon cannot claim');
  PERFORM test.throws($q$select public.notify_dispatch_prepare()$q$, '42501', 'anon cannot prepare');
  PERFORM test.throws($q$select public.notify_dispatch_result(gen_random_uuid(), 'sent', null, 0)$q$, '42501', 'anon cannot record results');
  PERFORM test.throws($q$select public.notify_scheduler_tick()$q$, '42501', 'anon cannot run a scheduler tick');
  PERFORM test.throws('select * from public.notification_channels', '42501', 'anon cannot read channels');
  PERFORM test.throws('select * from public.notification_dispatch_runs', '42501', 'anon cannot read dispatch runs');
  PERFORM test.reset();
  PERFORM test.ok(public.notify_scheduler_tick() ->> 'scheduler' = 'not_configured', 'the owner (pg_cron) runs the tick; without the ops setup it sends nothing');
END $$;

-- ================= in-app parity before any channel: notifications as before, no delivery =================
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  INSERT INTO public.card_assignees (card_id, member_id) VALUES ('n1-k3', current_setting('t.mb'));
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notifications WHERE recipient_id = current_setting('t.b')::uuid AND type = 'assignment' AND card_id = 'n1-k3') = 1,
    'without channels the in-app assignment notification is created as before');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries) = 0, 'without channels nothing is queued');
END $$;

-- ================= Telegram linking: single-use token, any server request resolves it, confirmation by the owner =================
DO $$
DECLARE v uuid;
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'n-ed@example.test');
  v := public.notify_link_begin(repeat('n', 40), 'telegram', encode(sha256('tg-token-b'), 'hex'));
  PERFORM set_config('t.chb', v::text, false);
  PERFORM test.ok(v IS NOT NULL, 'editor begins a Telegram link (token stored only as SHA-256)');
  PERFORM test.throws($q$select public.notify_link_begin(repeat('n', 40), 'telegram', encode(sha256('tg-token-b2'), 'hex'))$q$, 'PT429', 'an immediate second link request is rate limited');
  PERFORM test.throws($q$select public.notify_link_begin(repeat('n', 40), 'teams', repeat('a', 64))$q$, '22023', 'unknown provider refused');
  PERFORM test.throws($q$select public.notify_link_begin(repeat('n', 40), 'telegram', 'not-a-hash')$q$, '22023', 'malformed hash refused');
END $$;
DO $$
DECLARE v uuid;
BEGIN
  -- the /start update is processed by WHOEVER polls getUpdates next (here: the outsider's request)
  PERFORM test.act_as(current_setting('t.d')::uuid, 'n-out@example.test');
  v := public.notify_telegram_lookup(repeat('n', 40), encode(sha256('tg-token-b'), 'hex'));
  PERFORM test.ok(v = current_setting('t.chb')::uuid, 'a token resolves to its channel whoever processes the update');
  PERFORM test.ok(public.notify_telegram_attach(repeat('n', 40), encode(sha256('tg-token-b'), 'hex'), 'v1.0000beef.aaaa.bbbb.cccc', 'Eva (@eva_test)') = v, 'chat attached');
  PERFORM test.ok(public.notify_telegram_attach(repeat('n', 40), encode(sha256('tg-token-b'), 'hex'), 'v1.0000beef.dddd.eeee.ffff', 'Útočník') IS NULL, 'N8: the token is single use (replay attaches nothing)');
  PERFORM test.ok(public.notify_telegram_lookup(repeat('n', 40), encode(sha256('tg-unknown'), 'hex')) IS NULL, 'unknown token resolves to nothing');
  PERFORM test.ok(public.notify_telegram_confirm(repeat('n', 40), true) = 'none', 'N8: another user cannot confirm the chat');
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT status = 'confirm' AND label = 'Eva (@eva_test)' AND link_hash IS NULL FROM public.notification_channels WHERE id = current_setting('t.chb')::uuid),
    'N8: after /start the channel waits for confirmation in ClearSpace (nothing delivered yet)');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'n-ed@example.test');
  PERFORM test.ok((public.notify_status(repeat('n', 40)) -> 'channels' -> 0 ->> 'status') = 'confirm', 'owner sees the pending confirmation and the chat label');
  PERFORM test.ok(public.notify_telegram_confirm(repeat('n', 40), true) = 'active', 'owner confirms -> active');
END $$;
DO $$ BEGIN
  -- expired token
  PERFORM test.act_as(current_setting('t.c')::uuid, 'n-view@example.test');
  PERFORM public.notify_link_begin(repeat('n', 40), 'telegram', encode(sha256('tg-token-c'), 'hex'));
END $$;
DO $$ BEGIN
  UPDATE public.notification_channels SET link_expires_at = now() - interval '1 second' WHERE user_id = current_setting('t.c')::uuid;
  PERFORM test.act_as(current_setting('t.c')::uuid, 'n-view@example.test');
  PERFORM test.ok(public.notify_telegram_lookup(repeat('n', 40), encode(sha256('tg-token-c'), 'hex')) IS NULL, 'N8: an expired token resolves to nothing');
  PERFORM test.ok(public.notify_telegram_attach(repeat('n', 40), encode(sha256('tg-token-c'), 'hex'), 'v1.0000beef.aaaa.bbbb.cccc', 'X') IS NULL, 'N8: and attaches nothing');
END $$;
DO $$ BEGIN
  -- viewer: linked directly (fixture) to test the viewer path below
  UPDATE public.notification_channels SET status = 'active', secret_enc = 'v1.0000beef.cccc.cccc.cccc', link_hash = NULL, label = 'Cyril' WHERE user_id = current_setting('t.c')::uuid;
END $$;

-- ================= Slack OAuth state: own and unexpired only; credential replaced across workspaces =================
DO $$
DECLARE v uuid; r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  v := public.notify_link_begin(repeat('n', 40), 'slack', encode(sha256('slack-state-a1'), 'hex'));
  PERFORM test.act_as(current_setting('t.b')::uuid, 'n-ed@example.test');
  PERFORM test.ok(public.notify_slack_lookup(repeat('n', 40), encode(sha256('slack-state-a1'), 'hex')) IS NULL, 'N9: another user cannot use my OAuth state');
  PERFORM test.throws($q$select * from public.notify_slack_complete(repeat('n', 40), encode(sha256('slack-state-a1'), 'hex'), 'v1.0000beef.aaaa.bbbb.cccc', repeat('1', 64), 'Cizí')$q$, '22023', 'N9: nor complete it');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  PERFORM test.ok(public.notify_slack_lookup(repeat('n', 40), encode(sha256('slack-state-a1'), 'hex')) = v, 'own state resolves to own channel');
  SELECT * INTO r FROM public.notify_slack_complete(repeat('n', 40), encode(sha256('slack-state-a1'), 'hex'), 'v1.0000beef.a1a1.a1a1.a1a1', repeat('1', 64), 'Corvane Slack');
  PERFORM test.ok(r IS NULL OR r.old_secret_enc IS NULL, 'first Slack connection: nothing to revoke');
  PERFORM test.throws($q$select * from public.notify_slack_complete(repeat('n', 40), encode(sha256('slack-state-a1'), 'hex'), 'v1.0000beef.a1a1.a1a1.a1a1', repeat('1', 64), 'X')$q$, '22023', 'N9: the state is single use');
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT status = 'active' AND team_hmac = repeat('1', 64) FROM public.notification_channels WHERE user_id = current_setting('t.a')::uuid AND provider = 'slack'), 'Slack channel active');
  -- the outsider uses the SAME Slack workspace (fixture)
  INSERT INTO public.notification_channels (user_id, provider, status, secret_enc, team_hmac, label)
  VALUES (current_setting('t.d')::uuid, 'slack', 'active', 'v1.0000beef.d1d1.d1d1.d1d1', repeat('1', 64), 'Corvane Slack');
  UPDATE public.notification_channels SET link_issued_at = now() - interval '1 minute' WHERE user_id = current_setting('t.a')::uuid;
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  PERFORM public.notify_link_begin(repeat('n', 40), 'slack', encode(sha256('slack-state-a2'), 'hex'));
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  SELECT * INTO r FROM public.notify_slack_complete(repeat('n', 40), encode(sha256('slack-state-a2'), 'hex'), 'v1.0000beef.a2a2.a2a2.a2a2', repeat('2', 64), 'Jiný workspace');
  PERFORM test.ok(r.old_secret_enc = 'v1.0000beef.a1a1.a1a1.a1a1' AND r.old_team_shared = 1, 'N9: reconnecting to another workspace returns the old token and that 1 other user still uses it (no revoke)');
END $$;

-- ================= enqueue: in-app notification -> delivery (same moment), activity -> task_completed / task_due_changed =================
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  INSERT INTO public.card_assignees (card_id, member_id) VALUES ('n1-k1', current_setting('t.mb')), ('n1-k1', current_setting('t.me')), ('n1-k1', current_setting('t.mc'));
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.b')::uuid AND kind = 'assignment' AND card_id = 'n1-k1'
                     AND dedupe_key = 'n:' || (SELECT id FROM public.notifications WHERE recipient_id = current_setting('t.b')::uuid AND card_id = 'n1-k1' AND type = 'assignment')::text) = 1,
    'M3: assignment -> one delivery for the assignee with an active channel (keyed by the in-app notification)');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.e')::uuid) = 0, 'no channel -> nothing queued (in-app only)');
  PERFORM test.ok((SELECT count(*) FROM public.notifications WHERE recipient_id = current_setting('t.e')::uuid AND type = 'assignment' AND card_id = 'n1-k1') = 1, 'N16: in-app notification exists regardless of channels');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid AND kind = 'assignment') = 1, 'viewer with a channel is notified like in-app');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notification_deliveries'
                                AND column_name IN ('title', 'text', 'body', 'message', 'actor_name', 'project_name')), 'outbox has no text columns (messages are built at send time)');
  -- invitation / invitation_accepted are never delivered externally
  INSERT INTO public.notifications (recipient_id, project_id, type, actor_name, entity_type, entity_id, title)
  VALUES (current_setting('t.b')::uuid, 'n1', 'invitation_accepted', 'Někdo', 'project', 'n1', 'Rekonstrukce kanceláře');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.b')::uuid AND kind NOT IN ('assignment')) = 0, 'invitation_accepted is not delivered externally');
  INSERT INTO public.notifications (recipient_id, project_id, type, actor_name, entity_type, entity_id, card_id, title)
  VALUES (current_setting('t.b')::uuid, 'n1', 'mention', 'Anna', 'comment', 'cmt-1', 'n1-k1', 'Objednat nábytek <!channel> & spol.');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.b')::uuid AND kind = 'mention') = 1, 'mention -> delivery');
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  UPDATE public.cards SET column_id = 'n1-done' WHERE id = 'n1-k1';
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.b')::uuid AND kind = 'task_completed' AND card_id = 'n1-k1') = 1, 'M5: my task moved to Hotovo by someone else -> task_completed');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.a')::uuid AND kind = 'task_completed') = 0, 'the actor is never notified');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  UPDATE public.cards SET column_id = 'n1-todo', due_date = '2026-12-11' WHERE id = 'n1-k1';
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.b')::uuid AND kind = 'task_due_changed') = 1, 'M5: due date of my task changed by someone else -> task_due_changed');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE kind = 'task_completed') = 2, 'moving OUT of Hotovo is not a completion (b + viewer c from the first move only)');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'n-ed@example.test');
  UPDATE public.cards SET due_date = '2026-12-12' WHERE id = 'n1-k1';
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.b')::uuid AND kind = 'task_due_changed') = 1, 'my own due-date change does not notify me');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid AND kind = 'task_due_changed') = 2, 'the other assignee (viewer c) gets both changes');
END $$;

-- ================= preferences: types, projects, applied to the queue too =================
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'n-view@example.test');
  PERFORM test.throws($q$select public.notify_prefs_set(repeat('n', 40), ARRAY['assignment', 'chat_message'], null, false)$q$, '22023', 'unknown event type refused');
  PERFORM test.throws($q$select public.notify_prefs_set(repeat('n', 40), ARRAY['assignment'], ARRAY['n1; drop table x'], false)$q$, '22023', 'malformed project id refused');
  PERFORM public.notify_prefs_set(repeat('n', 40), ARRAY['assignment', 'due_soon', 'mention'], null, true);
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid AND kind = 'task_due_changed' AND status = 'cancelled' AND last_error_code = 'preferences') = 2,
    'N10: switching a type off cancels what is already queued');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  UPDATE public.cards SET due_date = '2026-12-13' WHERE id = 'n1-k1';
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid AND kind = 'task_due_changed' AND status = 'pending') = 0, 'N10: a disabled type is not queued');
  PERFORM test.act_as(current_setting('t.c')::uuid, 'n-view@example.test');
  PERFORM public.notify_prefs_set(repeat('n', 40), ARRAY['assignment', 'due_soon', 'mention'], ARRAY['n2'], true);
  PERFORM test.ok((public.notify_status(repeat('n', 40)) -> 'preferences' ->> 'hideTitles')::boolean, 'preferences round-trip (hide titles)');
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid AND status = 'pending') = 0, 'N10: a project outside the selection cancels its queue');
  PERFORM public.notify_prefs_allow(current_setting('t.c')::uuid, 'assignment', 'n1');
  PERFORM test.ok(NOT public.notify_prefs_allow(current_setting('t.c')::uuid, 'assignment', 'n1') AND public.notify_prefs_allow(current_setting('t.c')::uuid, 'assignment', 'n2'), 'project filter');
  PERFORM test.ok(NOT public.notify_prefs_allow(current_setting('t.c')::uuid, 'project_added', 'n2'), 'project membership group follows its own switch');
END $$;

-- ================= N12: the delivery layer can never fail the user's write =================
DO $$ BEGIN
  ALTER TABLE public.notification_deliveries ADD CONSTRAINT t_always_fails CHECK (false) NOT VALID;
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  INSERT INTO public.card_assignees (card_id, member_id) VALUES ('n1-k2', current_setting('t.mb'));
  UPDATE public.cards SET due_date = '2027-03-29' WHERE id = 'n1-k3';
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notifications WHERE recipient_id = current_setting('t.b')::uuid AND card_id = 'n1-k2' AND type = 'assignment') = 1,
    'N12: enqueue failing inside the trigger -> the assignment and its in-app notification still commit');
  PERFORM test.ok((SELECT due_date FROM public.cards WHERE id = 'n1-k3') = '2027-03-29', 'N12: and the card update commits');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE card_id = 'n1-k2') = 0, 'nothing was queued while failing');
  ALTER TABLE public.notification_deliveries DROP CONSTRAINT t_always_fails;
END $$;

-- ================= dispatcher: claim re-checks everything; results; leases; retry/backoff =================
DO $$
DECLARE r record; n int := 0;
BEGIN
  PERFORM test.reset();
  FOR r IN SELECT * FROM public.notify_dispatch_claim(50, 120) LOOP
    n := n + 1;
    IF r.kind = 'assignment' AND r.user_id = current_setting('t.b')::uuid THEN
      PERFORM set_config('t.d1', r.id::text, false);
      PERFORM test.ok(r.provider = 'telegram' AND r.title = 'Objednat nábytek <!channel> & spol.' AND r.project_name = 'Rekonstrukce kanceláře'
                      AND r.actor_name IS NOT NULL AND r.secret_enc LIKE 'v1.%' AND r.attempts = 1 AND NOT r.hide_titles,
                      'claim returns current names, the credential envelope and attempt 1');
    ELSIF r.kind = 'task_due_changed' AND r.new_due = '2026-12-11' THEN
      PERFORM test.ok(true, 'task_due_changed carries the new date from the activity (2026-12-11)');
      PERFORM set_config('t.d2', r.id::text, false);
    ELSIF r.kind = 'task_due_changed' THEN
      PERFORM test.ok(r.new_due = '2026-12-13', 'second due change carries 2026-12-13');
    ELSIF r.kind = 'mention' THEN PERFORM set_config('t.d3', r.id::text, false);
    ELSIF r.kind = 'task_completed' THEN PERFORM set_config('t.d4', r.id::text, false);
    END IF;
  END LOOP;
  PERFORM test.ok(n = 5, 'N1: five valid deliveries claimed (b: assignment, mention, task_completed, 2x task_due_changed)');
  PERFORM test.ok((SELECT count(*) FROM public.notify_dispatch_claim(50, 120)) = 0, 'N1: a second (concurrent) run gets none of the leased rows');
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid AND status = 'pending') = 0
                  AND (SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid AND status = 'cancelled' AND last_error_code = 'preferences') >= 1,
                  'N10: preferences checked again at claim');
  PERFORM test.reset();
  PERFORM test.ok(public.notify_dispatch_result(current_setting('t.d1')::uuid, 'sent', null, null) = 'sent', 'result sent');
  PERFORM test.ok(public.notify_dispatch_result(current_setting('t.d1')::uuid, 'sent', null, null) = 'not_leased', 'N1: a result for a finished delivery is ignored');
  PERFORM test.ok(public.notify_dispatch_result(current_setting('t.d2')::uuid, 'retry', 'http_503', 0) = 'pending', 'N4: 5xx -> retry');
  PERFORM test.ok(public.notify_dispatch_result(current_setting('t.d3')::uuid, 'retry', 'rate_limited', 600) = 'pending', 'N4: 429 with Retry-After 600 -> retry');
  PERFORM test.ok(public.notify_dispatch_result(current_setting('t.d4')::uuid, 'release', 'rate_limited', 5) = 'pending', 'release (not tried) -> pending');
  PERFORM test.throws($q$select public.notify_dispatch_result(gen_random_uuid(), 'delivered!', null, 0)$q$, '22023', 'unknown outcome refused');
  PERFORM test.throws($q$select public.notify_dispatch_result(gen_random_uuid(), 'failed', 'Bot token 123:ABC', 0)$q$, '22023', 'N13: error codes are short codes only (no provider text)');
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT status = 'sent' FROM public.notification_deliveries WHERE id = current_setting('t.d1')::uuid)
                  AND (SELECT last_sent_at IS NOT NULL FROM public.notification_channels WHERE user_id = current_setting('t.b')::uuid), 'sent recorded on delivery and channel');
  PERFORM test.ok((SELECT next_attempt_at BETWEEN now() + interval '55 seconds' AND now() + interval '65 seconds' FROM public.notification_deliveries WHERE id = current_setting('t.d2')::uuid), 'N4: first retry after 1 minute');
  PERFORM test.ok((SELECT next_attempt_at > now() + interval '590 seconds' FROM public.notification_deliveries WHERE id = current_setting('t.d3')::uuid), 'N4: Retry-After longer than the backoff wins');
  PERFORM test.ok((SELECT attempts = 0 AND next_attempt_at < now() + interval '10 seconds' FROM public.notification_deliveries WHERE id = current_setting('t.d4')::uuid), 'release does not count the attempt');
  -- attempts exhausted
  UPDATE public.notification_deliveries SET attempts = 4, next_attempt_at = now() - interval '1 second' WHERE id = current_setting('t.d2')::uuid;
  UPDATE public.notification_deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = current_setting('t.d4')::uuid;
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.reset();
  SELECT * INTO r FROM public.notify_dispatch_claim(50, 120) WHERE id = current_setting('t.d2')::uuid;
  PERFORM test.ok(r.attempts = 5, 'fifth attempt claimed');
  PERFORM test.ok(public.notify_dispatch_result(r.id, 'retry', 'http_503', 0) = 'failed', 'N4: after 5 attempts -> failed');
  -- d4 (released) was claimed again in that run: simulate a crash mid-send (lease expires)
  PERFORM test.reset();
  UPDATE public.notification_deliveries SET lease_until = now() - interval '1 second' WHERE id = current_setting('t.d4')::uuid AND status = 'sending';
END $$;
DO $$ BEGIN
  PERFORM test.reset();
  PERFORM test.ok((public.notify_dispatch_prepare() ->> 'ambiguous')::int = 1, 'N6/N15: an interrupted send (expired lease) is marked failed, never re-sent');
  PERFORM test.reset();
  PERFORM test.ok((SELECT status = 'failed' AND last_error_code = 'ambiguous' FROM public.notification_deliveries WHERE id = current_setting('t.d4')::uuid), 'N6: ambiguous = at most once');
END $$;

-- ================= cancellation at claim: access lost, unassigned, archived, source gone, provider off =================
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  INSERT INTO public.cards (id, column_id, title, due_date) VALUES ('n1-k4', 'n1-todo', 'Stěhování', NULL), ('n1-k5', 'n1-todo', 'Úklid', NULL), ('n1-k6', 'n1-todo', 'Klíče', NULL);
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  INSERT INTO public.card_assignees (card_id, member_id) VALUES ('n1-k4', current_setting('t.mb')), ('n1-k5', current_setting('t.mb')), ('n1-k6', current_setting('t.mb'));
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE card_id IN ('n1-k4', 'n1-k5', 'n1-k6') AND status = 'pending') = 3, 'three new assignments queued');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  DELETE FROM public.card_assignees WHERE card_id = 'n1-k4';
  UPDATE public.cards SET archived = true WHERE id = 'n1-k5';
END $$;
DO $$ BEGIN
  DELETE FROM public.notifications WHERE recipient_id = current_setting('t.b')::uuid AND card_id = 'n1-k6';   -- dismissed in the app
  PERFORM test.reset();
  PERFORM count(*) FROM public.notify_dispatch_claim(50, 120);
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT last_error_code FROM public.notification_deliveries WHERE card_id = 'n1-k4') = 'not_assigned', 'N3: unassigned before sending -> cancelled');
  PERFORM test.ok((SELECT last_error_code FROM public.notification_deliveries WHERE card_id = 'n1-k5') = 'card_archived', 'N3: archived -> cancelled');
  PERFORM test.ok((SELECT last_error_code FROM public.notification_deliveries WHERE card_id = 'n1-k6') = 'source_gone', 'D12: in-app notification removed -> not sent');
  UPDATE public.notification_deliveries SET status = 'cancelled' WHERE status IN ('pending', 'sending');
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  INSERT INTO public.cards (id, column_id, title) VALUES ('n1-k7', 'n1-todo', 'Předání');
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  INSERT INTO public.card_assignees (card_id, member_id) VALUES ('n1-k7', current_setting('t.mb'));
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  DELETE FROM public.project_members WHERE project_id = 'n1' AND member_id = current_setting('t.mb');
END $$;
DO $$ BEGIN
  PERFORM test.reset();
  PERFORM count(*) FROM public.notify_dispatch_claim(50, 120);
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT status = 'cancelled' AND last_error_code IN ('no_access', 'source_gone') FROM public.notification_deliveries WHERE card_id = 'n1-k7'),
    'N3: removed from the project before sending -> cancelled (no_access / its in-app notification purged)');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE kind = 'project_removed' AND user_id = current_setting('t.b')::uuid) = 1, 'project_removed is delivered to the removed member');
END $$;
DO $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM public.notification_deliveries WHERE kind = 'project_removed' AND user_id = current_setting('t.b')::uuid AND status = 'sending';
  PERFORM test.ok(v IS NOT NULL, 'project_removed was claimed without access to the project (it is about losing it)');
  PERFORM test.reset();
  PERFORM test.ok(public.notify_dispatch_result(v, 'sent', null, null) = 'sent', 'project_removed sent');
END $$;
-- b back in the project for the due-date tests
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  INSERT INTO public.project_members (project_id, member_id) VALUES ('n1', current_setting('t.mb'));
END $$;

-- ================= due dates (M4, N2, N17): Europe/Prague, 09:00 the day before, CET/CEST, catch-up, changes =================
DO $$ BEGIN
  PERFORM test.ok(public.notify_due_window_start('2026-12-10') = '2026-12-09 08:00:00+00', 'winter (CET): reminder at 09:00 local = 08:00 UTC the day before');
  PERFORM test.ok(public.notify_due_window_start('2027-03-28') = '2027-03-27 08:00:00+00', 'N17: due on the spring DST day -> reminder the day before still in CET (08:00 UTC)');
  PERFORM test.ok(public.notify_due_window_start('2027-03-29') = '2027-03-28 07:00:00+00', 'N17: reminder ON the spring DST day -> 09:00 CEST = 07:00 UTC');
  PERFORM test.ok(public.notify_due_window_start('2027-10-31') = '2027-10-30 07:00:00+00', 'N17: due on the autumn DST day -> reminder the day before in CEST (07:00 UTC)');
  PERFORM test.ok(public.notify_due_window_start('2027-11-01') = '2027-10-31 08:00:00+00', 'N17: reminder ON the autumn DST day -> 09:00 CET = 08:00 UTC');
  PERFORM test.ok(public.notify_due_window_end('2027-10-31') = '2027-10-31 23:00:00+00', 'N17: the window ends at local midnight after the due day (23:00 UTC in CET)');
  PERFORM test.ok(public.notify_due_window_end('2027-03-28') = '2027-03-28 22:00:00+00', 'N17: ... and 22:00 UTC in CEST');
  PERFORM test.ok(public.notify_due_window_start('2027-01-01') = '2026-12-31 08:00:00+00', 'month/year boundary');
END $$;
DO $$ BEGIN
  -- n1-k2 (due 2027-03-28) is assigned to b (above). 08:59 local the day before: nothing yet.
  PERFORM test.reset();
  PERFORM test.ok((public.notify_dispatch_prepare('2027-03-27 07:59:00+00') ->> 'dueQueued')::int = 0, 'N2: before 09:00 the day before -> no reminder');
  PERFORM test.ok((public.notify_dispatch_prepare('2027-03-27 08:00:00+00') ->> 'dueQueued')::int = 1, 'M4: at 09:00 local the day before -> one reminder');
  PERFORM test.ok((public.notify_dispatch_prepare('2027-03-27 08:01:00+00') ->> 'dueQueued')::int = 0, 'N1/N2: the next tick queues nothing again');
  PERFORM test.ok((public.notify_dispatch_prepare('2027-03-28 06:30:00+00') ->> 'dueQueued')::int = 0, 'N15: a late tick (outage) on the due day does not duplicate');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.ok((SELECT dedupe_key = 'd:n1-k2:2027-03-28' AND due_date = '2027-03-28' FROM public.notification_deliveries WHERE kind = 'due_soon' AND card_id = 'n1-k2'), 'key = card + due date');
  PERFORM test.reset();
  SELECT * INTO r FROM public.notify_dispatch_claim(50, 120, '2027-03-29 00:00:00+00') WHERE kind = 'due_soon';
  PERFORM test.ok(r.id IS NULL, 'N2/N15: after the due day is over a queued reminder is not sent');
  PERFORM test.reset();
  PERFORM test.ok((SELECT last_error_code FROM public.notification_deliveries WHERE kind = 'due_soon' AND card_id = 'n1-k2') = 'expired', '... it is cancelled as expired');
END $$;
DO $$ BEGIN
  -- catch-up: the scheduler was down the whole day before; on the due day morning the reminder still goes out (n1-k1 assigned to b and c)
  UPDATE public.cards SET due_date = '2026-12-20', column_id = 'n1-todo' WHERE id = 'n1-k1';
  PERFORM test.reset();
  PERFORM test.ok((public.notify_dispatch_prepare('2026-12-20 06:30:00+00') ->> 'dueQueued')::int = 1, 'N15: catch-up on the due day itself (c has due_soon on but project filter n2 -> only b)');
END $$;
DO $$
DECLARE r record;
BEGIN
  -- due date changed after queueing -> stale reminder cancelled; new date -> new reminder
  UPDATE public.cards SET due_date = '2026-12-22' WHERE id = 'n1-k1';
  PERFORM test.reset();
  SELECT * INTO r FROM public.notify_dispatch_claim(50, 120, '2026-12-20 06:31:00+00') WHERE kind = 'due_soon';
  PERFORM test.ok(r.id IS NULL, 'N17: the reminder for the old date is not sent');
  PERFORM test.reset();
  PERFORM test.ok((SELECT last_error_code FROM public.notification_deliveries WHERE dedupe_key = 'd:n1-k1:2026-12-20' AND user_id = current_setting('t.b')::uuid) = 'due_changed', 'N17: ... cancelled as due_changed');
  PERFORM test.ok((public.notify_dispatch_prepare('2026-12-21 08:00:00+00') ->> 'dueQueued')::int = 1, 'N17: the new date gets its own reminder');
  UPDATE public.cards SET column_id = 'n1-done' WHERE id = 'n1-k1';
  SELECT * INTO r FROM public.notify_dispatch_claim(50, 120, '2026-12-21 08:01:00+00') WHERE kind = 'due_soon';
  PERFORM test.ok(r.id IS NULL AND (SELECT last_error_code FROM public.notification_deliveries WHERE dedupe_key = 'd:n1-k1:2026-12-22' AND user_id = current_setting('t.b')::uuid) = 'done',
    'N17: completed before sending -> cancelled as done');
  PERFORM test.ok((public.notify_dispatch_prepare('2026-12-21 09:00:00+00') ->> 'dueQueued')::int = 0, 'a completed task gets no reminder');
  UPDATE public.cards SET column_id = 'n1-todo', archived = true WHERE id = 'n1-k1';
  PERFORM test.ok((public.notify_dispatch_prepare('2026-12-21 09:00:00+00') ->> 'dueQueued')::int = 0, 'an archived task gets no reminder');
  UPDATE public.cards SET archived = false, due_date = 'zítra' WHERE id = 'n1-k1';
  PERFORM test.ok((public.notify_dispatch_prepare('2026-12-21 09:00:00+00') ->> 'dueQueued')::int = 0, 'a malformed due date is ignored');
END $$;

-- ================= provider switched off: queue dropped; channel reconnect / blocked =================
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  INSERT INTO public.card_assignees (card_id, member_id) VALUES ('n1-k3', current_setting('t.mc'));
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'n-view@example.test');
  PERFORM public.notify_prefs_set(repeat('n', 40), ARRAY['assignment'], null, false);
END $$;
DO $$ BEGIN
  INSERT INTO public.notifications (recipient_id, project_id, type, actor_name, entity_type, entity_id, card_id, title)
  VALUES (current_setting('t.c')::uuid, 'n1', 'assignment', 'Anna', 'task', 'n1-k3', 'n1-k3', 'Malování');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid AND status = 'pending') = 1, 'viewer queue: 1 pending');
  PERFORM test.reset();
  -- provider switch lives in the app: for a provider that is off it answers 'cancelled provider_disabled' (503 for both: tick drops the batch)
  PERFORM test.ok((SELECT public.notify_dispatch_result(c.id, 'cancelled', 'provider_disabled', null) FROM public.notify_dispatch_claim(50, 120) c
                    WHERE c.user_id = current_setting('t.c')::uuid LIMIT 1) = 'cancelled', 'N11: a delivery for a switched-off provider is cancelled, not sent');
  PERFORM test.ok((SELECT last_error_code FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid ORDER BY created_at DESC LIMIT 1) = 'provider_disabled', 'N11: ... as provider_disabled');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid AND status = 'pending') = 0, 'N11: nothing left to send for it');
END $$;
DO $$ BEGIN
  INSERT INTO public.notifications (recipient_id, project_id, type, actor_name, entity_type, entity_id, card_id, title)
  VALUES (current_setting('t.c')::uuid, 'n1', 'assignment', 'Anna', 'task', 'n1-k3b', 'n1-k3', 'Malování'),
         (current_setting('t.c')::uuid, 'n1', 'assignment', 'Anna', 'task', 'n1-k3c', 'n1-k3', 'Malování');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.reset();
  SELECT * INTO r FROM public.notify_dispatch_claim(1, 120) WHERE user_id = current_setting('t.c')::uuid;
  PERFORM test.ok(public.notify_dispatch_result(r.id, 'blocked', 'telegram_blocked', null) = 'failed', 'N5: bot blocked by the user -> failed');
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT status = 'blocked' AND last_error_code = 'telegram_blocked' FROM public.notification_channels WHERE user_id = current_setting('t.c')::uuid), 'N5: channel marked blocked');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid AND status = 'pending') = 0, 'N5: its other queued deliveries are cancelled');
  INSERT INTO public.notifications (recipient_id, project_id, type, actor_name, entity_type, entity_id, card_id, title)
  VALUES (current_setting('t.c')::uuid, 'n1', 'assignment', 'Anna', 'task', 'n1-k3d', 'n1-k3', 'Malování');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.c')::uuid AND status = 'pending') = 0, 'N5: nothing is queued for a blocked channel');
END $$;

-- ================= pause, test message throttle, disconnect (Slack shared workspace), account deletion =================
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'n-ed@example.test');
  PERFORM test.ok(public.notify_channel_set_enabled(repeat('n', 40), 'telegram', false), 'pause own channel');
  PERFORM test.ok(NOT public.notify_channel_set_enabled(repeat('n', 40), 'slack', false), 'no Slack channel -> nothing changed');
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'n-own@example.test');
  INSERT INTO public.card_assignees (card_id, member_id) VALUES ('n1-k4', current_setting('t.mb'));
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notifications WHERE recipient_id = current_setting('t.b')::uuid AND card_id = 'n1-k4' AND type = 'assignment') = 1, 're-assignment creates the in-app notification');
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.b')::uuid AND card_id = 'n1-k4' AND status = 'pending') = 0, 'a paused channel queues nothing');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'n-ed@example.test');
  PERFORM public.notify_channel_set_enabled(repeat('n', 40), 'telegram', true);
  PERFORM test.throws($q$select * from public.notify_test_begin(repeat('n', 40), 'slack')$q$, '22023', 'test message needs a connected channel');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'n-ed@example.test');
  SELECT * INTO r FROM public.notify_test_begin(repeat('n', 40), 'telegram');
  PERFORM test.ok(r.secret_enc LIKE 'v1.%', 'test message: own credential envelope');
  PERFORM test.throws($q$select * from public.notify_test_begin(repeat('n', 40), 'telegram')$q$, 'PT429', 'test message at most once per 30 s');
  PERFORM public.notify_channel_mark(repeat('n', 40), 'telegram', 'sent', null);
  PERFORM test.throws($q$select public.notify_channel_mark(repeat('n', 40), 'telegram', 'sent', 'Bearer x')$q$, '22023', 'channel mark accepts codes only');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.d')::uuid, 'n-out@example.test');
  SELECT * INTO r FROM public.notify_channel_remove(repeat('n', 40), 'slack');
  PERFORM test.ok(r.secret_enc = 'v1.0000beef.d1d1.d1d1.d1d1' AND r.team_shared = 0, 'N14: disconnect returns the credential to revoke; workspace no longer shared (a moved to another workspace)');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'n-ed@example.test');
  SELECT * INTO r FROM public.notify_channel_remove(repeat('n', 40), 'telegram');
  PERFORM test.ok(r.channel_id IS NOT NULL, 'Telegram disconnected');
  SELECT * INTO r FROM public.notify_channel_remove(repeat('n', 40), 'telegram');
  PERFORM test.ok(r IS NULL OR r.channel_id IS NULL, 'disconnect twice is a no-op');
END $$;
DO $$ BEGIN
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE user_id = current_setting('t.b')::uuid) = 0, 'N14: the queue of a removed channel is gone (cascade)');
  DELETE FROM auth.users WHERE id = current_setting('t.c')::uuid;
  PERFORM test.ok((SELECT count(*) FROM public.notification_channels WHERE user_id = current_setting('t.c')::uuid) = 0
                  AND (SELECT count(*) FROM public.notification_preferences WHERE user_id = current_setting('t.c')::uuid) = 0, 'N14: account deletion removes channels and preferences');
END $$;

-- ================= retention =================
DO $$ BEGIN
  INSERT INTO public.notification_deliveries (channel_id, user_id, kind, dedupe_key, project_id, status, updated_at)
  SELECT c.id, c.user_id, 'project_added', 'n:old-' || s, 'n1', CASE WHEN s = 1 THEN 'sent' ELSE 'pending' END, now() - interval '31 days'
    FROM public.notification_channels c, generate_series(1, 2) s WHERE c.user_id = current_setting('t.a')::uuid AND c.provider = 'slack';
  PERFORM test.reset();
  PERFORM test.ok((public.notify_dispatch_prepare() ->> 'purged')::int >= 1, 'D13: finished deliveries older than 30 days are purged');
  PERFORM test.reset();
  PERFORM test.ok((SELECT count(*) FROM public.notification_deliveries WHERE dedupe_key = 'n:old-2') = 1, 'D13: unfinished deliveries are kept');
END $$;
