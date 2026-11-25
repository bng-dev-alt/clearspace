-- Google connections + Drive links (20261126001200). AUTOCOMMIT mode like 90/91: each DO block is one committed
-- transaction (one request), so triggers and events behave as in production.
\set ON_ERROR_STOP 1

DO $$
DECLARE a uuid; b uuid; c uuid; d uuid;
BEGIN
  a := test.mkuser('g-own@example.test'); b := test.mkuser('g-ed@example.test');
  c := test.mkuser('g-view@example.test'); d := test.mkuser('g-out@example.test');
  PERFORM set_config('t.a', a::text, false); PERFORM set_config('t.b', b::text, false);
  PERFORM set_config('t.c', c::text, false); PERFORM set_config('t.d', d::text, false);
  INSERT INTO public.server_trust (purpose, secret_sha256)
  VALUES ('google', encode(sha256(convert_to(repeat('g', 40), 'UTF8')), 'hex'))
  ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  INSERT INTO public.projects (id, name) VALUES ('g1', 'Drive'), ('g2', 'Jiný');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('g1-a', 'g1', 'A', 0), ('g2-a', 'g2', 'A', 0);
  INSERT INTO public.project_members (project_id, member_id) VALUES ('g1', 'member-owner-' || current_setting('t.a')), ('g2', 'member-owner-' || current_setting('t.a'));
  INSERT INTO public.cards (id, column_id, title) VALUES ('g1-k1', 'g1-a', 'Smlouva'), ('g1-k2', 'g1-a', 'Rozpočet'), ('g2-k1', 'g2-a', 'Cizí');
  SELECT * INTO r FROM public.create_project_invitation('g1', 'g-ed@example.test', 'member'); PERFORM set_config('t.tb', r.token, false);
  SELECT * INTO r FROM public.create_project_invitation('g1', 'g-view@example.test', 'viewer'); PERFORM set_config('t.tc', r.token, false);
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'g-ed@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tb'), 'Editor Eva'); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.c')::uuid, 'g-view@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tc'), 'Čtenář Cyril'); END $$;

-- ================= credentials are invisible to clients =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  PERFORM test.throws('select * from public.google_connections', '42501', 'authenticated cannot read google_connections');
  PERFORM test.throws('select * from public.google_oauth_states', '42501', 'authenticated cannot read google_oauth_states');
  PERFORM test.throws('insert into public.google_connections (user_id, google_sub, google_email, scopes, refresh_token_enc) values (auth.uid(), ''1'', ''x@y.z'', ''{a}'', ''v1.00000000.a.b.c'')', '42501', 'nor write it');
  PERFORM test.throws('select public.google_credentials_get(null, 0)', '42501', 'server RPC without the secret is refused');
  PERFORM test.throws('select public.google_credentials_get(repeat(''x'', 40), 0)', '42501', 'server RPC with a wrong secret is refused');
  PERFORM test.throws('select public.require_server_secret(''google'', repeat(''g'', 40))', '42501', 'the secret check itself is not callable by clients');
  PERFORM test.act_as_anon();
  PERFORM test.throws('select public.google_connection_status()', '42501', 'anon cannot call the status projection');
  PERFORM test.throws('select public.google_oauth_begin(repeat(''g'', 40), repeat(''a'', 64), repeat(''b'', 64), ''x'', ''/settings'', ''{openid}'')', '42501', 'anon cannot begin an OAuth transaction');
END $$;

-- ================= OAuth transaction: bound, expiring, single use =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  PERFORM public.google_oauth_begin(repeat('g', 40), repeat('1', 64), repeat('b', 64), 'enc-verifier', '/projects/g1', ARRAY['openid', 'email', 'https://www.googleapis.com/auth/drive.file']);
  PERFORM test.throws('select public.google_oauth_begin(repeat(''g'', 40), repeat(''2'', 64), repeat(''b'', 64), ''x'', ''https://evil.example'', ''{openid}'')', '23514', 'return path must be a local path (no open redirect)');
  PERFORM test.act_as_anon();
  PERFORM test.throws('select * from public.google_oauth_consume(repeat(''g'', 40), repeat(''1'', 64), repeat(''b'', 64))', '42501', 'completion is never anonymous');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'g-out@example.test');
  PERFORM test.throws('select * from public.google_oauth_consume(repeat(''g'', 40), repeat(''1'', 64), repeat(''b'', 64))', '22023', 'another ClearSpace session cannot consume the transaction (account-linking)');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  PERFORM test.throws('select * from public.google_oauth_consume(repeat(''g'', 40), repeat(''1'', 64), repeat(''c'', 64))', '22023', 'consume with another browser''s binding is refused');
  PERFORM test.ok((select user_id from public.google_oauth_consume(repeat('g', 40), repeat('1', 64), repeat('b', 64))) = current_setting('t.a')::uuid, 'consume returns the initiating user');
  PERFORM test.throws('select * from public.google_oauth_consume(repeat(''g'', 40), repeat(''1'', 64), repeat(''b'', 64))', '22023', 'a state is consumed only once');
  PERFORM test.throws('select public.google_oauth_complete(repeat(''g'', 40), repeat(''1'', 64), ''111'', ''anna@example.test'', ''{openid}'', null, null, null)', '22023', 'first connect without a refresh token is refused');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  PERFORM public.google_oauth_begin(repeat('g', 40), repeat('3', 64), repeat('b', 64), 'enc', '/settings', ARRAY['openid']);
  PERFORM public.google_oauth_consume(repeat('g', 40), repeat('3', 64), repeat('b', 64));
  PERFORM test.ok(public.google_oauth_complete(repeat('g', 40), repeat('3', 64), '111', 'anna@example.test', ARRAY['openid', 'email', 'https://www.googleapis.com/auth/drive.file'],
    'v1.0000aaaa.aaaa.bbbb.cccc', 'v1.0000aaaa.dddd.eeee.ffff', now() + interval '1 hour') = '/settings', 'complete stores the connection and returns the validated path');
  PERFORM test.throws('select public.google_oauth_complete(repeat(''g'', 40), repeat(''3'', 64), ''111'', ''anna@example.test'', ''{openid}'', ''v1.0000aaaa.a.b.c'', null, null)', '22023', 'a state completes only once');
END $$;
DO $$
BEGIN
  -- an expired, never-used state
  PERFORM test.reset();
  INSERT INTO public.google_oauth_states (state_sha256, user_id, binding_sha256, code_verifier_enc, return_to, scopes, expires_at)
  VALUES (repeat('4', 64), current_setting('t.b')::uuid, repeat('b', 64), 'enc', '/settings', '{openid}', now() - interval '1 second');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'g-ed@example.test');
  PERFORM test.throws('select * from public.google_oauth_consume(repeat(''g'', 40), repeat(''4'', 64), repeat(''b'', 64))', '22023', 'an expired state is refused');
END $$;
DO $$
BEGIN
  -- the same Google account for a second ClearSpace user
  PERFORM test.act_as(current_setting('t.b')::uuid, 'g-ed@example.test');
  PERFORM public.google_oauth_begin(repeat('g', 40), repeat('5', 64), repeat('b', 64), 'enc', '/settings', ARRAY['openid']);
  PERFORM public.google_oauth_consume(repeat('g', 40), repeat('5', 64), repeat('b', 64));
  PERFORM test.throws('select public.google_oauth_complete(repeat(''g'', 40), repeat(''5'', 64), ''111'', ''anna@example.test'', ''{openid}'', ''v1.0000aaaa.a.b.c'', null, null)', '23505', 'one Google account cannot belong to two ClearSpace accounts');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'g-ed@example.test');
  PERFORM public.google_oauth_begin(repeat('g', 40), repeat('6', 64), repeat('b', 64), 'enc', '/settings', ARRAY['openid']);
  PERFORM public.google_oauth_consume(repeat('g', 40), repeat('6', 64), repeat('b', 64));
  PERFORM public.google_oauth_complete(repeat('g', 40), repeat('6', 64), '222', 'bohdan@example.test', ARRAY['openid', 'email', 'https://www.googleapis.com/auth/drive.file'], 'v1.0000aaaa.b.b.b', null, null);
END $$;
DO $$
DECLARE n int;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  PERFORM test.ok((select google_email from public.google_connection_status()) = 'anna@example.test', 'status projection: own account only');
  PERFORM test.ok((select count(*) from public.google_credentials_get(repeat('g', 40), 0)) = 1 AND (select user_id from public.google_credentials_get(repeat('g', 40), 0)) = auth.uid(), 'credentials RPC returns only the caller''s own row');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'g-out@example.test');
  PERFORM test.ok((select count(*) from public.google_credentials_get(repeat('g', 40), 0)) = 0, 'another user gets nothing (even with the server secret)');
  PERFORM test.ok((select count(*) from public.integration_audit) = 0, 'and sees no one else''s audit');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  SELECT count(*) INTO n FROM public.integration_audit WHERE event = 'connected';
  PERFORM test.ok(n = 1, 'connect audited for the owner of the connection');
END $$;

-- ================= refresh lease / store / revoke / budget =================
DO $$
DECLARE v bigint;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  SELECT token_version INTO v FROM public.google_credentials_get(repeat('g', 40), 0);
  PERFORM test.ok(public.google_refresh_lease(repeat('g', 40), v), 'first request takes the refresh lease');
  PERFORM test.ok(NOT public.google_refresh_lease(repeat('g', 40), v), 'a concurrent request does not');
  PERFORM test.ok(NOT public.google_refresh_store(repeat('g', 40), v + 7, 'v1.0000aaaa.x.x.x', now() + interval '1 hour', null), 'a stale version cannot overwrite');
  PERFORM test.ok(public.google_refresh_store(repeat('g', 40), v, 'v1.0000aaaa.n.n.n', now() + interval '1 hour', null), 'the lease holder stores the new token');
  PERFORM test.ok((select token_version from public.google_credentials_get(repeat('g', 40), 0)) = v + 1
              AND (select refresh_token_enc from public.google_credentials_get(repeat('g', 40), 0)) = 'v1.0000aaaa.aaaa.bbbb.cccc', 'version bumped, refresh token kept when Google returned none');
  PERFORM test.ok(public.google_refresh_lease(repeat('g', 40), v + 1), 'lease released after storing');
  PERFORM public.google_connection_mark(repeat('g', 40), 'active', 'unavailable');
  PERFORM test.ok(public.google_refresh_lease(repeat('g', 40), v + 1), 'a failed refresh releases the lease too');
  PERFORM public.google_connection_mark(repeat('g', 40), 'revoked', 'invalid_grant');
  PERFORM test.ok((select status = 'revoked' and access_token_enc is null from public.google_credentials_get(repeat('g', 40), 0)), 'invalid_grant: revoked, access token dropped');
  PERFORM test.ok(NOT public.google_refresh_lease(repeat('g', 40), v + 1), 'no refresh on a revoked connection');
  PERFORM test.ok((select count(*) from public.integration_audit where event = 'revoked_by_provider') = 1, 'provider revocation audited');
  PERFORM test.throws('select public.google_connection_mark(repeat(''g'', 40), ''hacked'', null)', '22023', 'unknown status refused');
  PERFORM test.throws('select public.google_credentials_get(repeat(''g'', 40), 51)', '22023', 'cost is bounded');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'g-ed@example.test');
  FOR i IN 1..6 LOOP PERFORM public.google_credentials_get(repeat('g', 40), 50); END LOOP;
  PERFORM test.throws('select public.google_credentials_get(repeat(''g'', 40), 1)', 'PT429', 'per-user Google API budget (300 / 10 min)');
  PERFORM test.reset();
  UPDATE public.google_connections SET api_window_start = now() - interval '11 minutes' WHERE user_id = current_setting('t.b')::uuid;
END $$;

-- ================= links: who may add, dedupe, validation =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'g-ed@example.test');
  PERFORM test.ok((select not duplicate from public.drive_link_add(repeat('g', 40), 'g1', null, 'fileProject0001', 'Rozpočet Q1', 'application/vnd.google-apps.spreadsheet', 'https://docs.google.com/spreadsheets/d/fileProject0001/edit', null, now(), 'ok')), 'editor links a file to the project');
  PERFORM test.ok((select duplicate from public.drive_link_add(repeat('g', 40), 'g1', null, 'fileProject0001', 'Rozpočet Q1', 'application/vnd.google-apps.spreadsheet', 'https://docs.google.com/spreadsheets/d/fileProject0001/edit', null, now(), 'ok')), 'the same file again is a duplicate, not a second row');
  PERFORM test.ok((select not duplicate from public.drive_link_add(repeat('g', 40), 'g1', 'g1-k1', 'fileProject0001', 'Rozpočet Q1', 'application/vnd.google-apps.spreadsheet', 'https://docs.google.com/spreadsheets/d/fileProject0001/edit', null, now(), 'ok')), 'the same file on a task is its own association');
  PERFORM test.throws('select public.drive_link_add(repeat(''g'', 40), ''g1'', ''g2-k1'', ''fileProject0002'', ''x'', ''text/plain'', ''https://drive.google.com/file/d/x/view'', null, null, ''ok'')', '42501', 'a card of another project cannot be used with this project');
  PERFORM test.throws('select public.drive_link_add(repeat(''g'', 40), ''g2'', null, ''fileProject0002'', ''x'', ''text/plain'', ''https://drive.google.com/file/d/x/view'', null, null, ''ok'')', '42501', 'not a member of g2: refused');
  PERFORM test.throws('select public.drive_link_add(repeat(''g'', 40), ''g1'', null, ''fileProject0003'', ''x'', ''text/plain'', ''javascript:alert(1)'', null, null, ''ok'')', '23514', 'only canonical https Google URLs');
  PERFORM test.throws('select public.drive_link_add(repeat(''g'', 40), ''g1'', null, ''fileProject0003'', ''x'', ''text/plain'', ''https://drive.google.com.evil.example/x'', null, null, ''ok'')', '23514', 'no look-alike hosts');
  PERFORM test.throws('select public.drive_link_add(repeat(''g'', 40), ''g1'', null, ''fileProject0003'', E''a\nb'', ''text/plain'', ''https://drive.google.com/file/d/x/view'', null, null, ''ok'')', '23514', 'no control characters in names');
  PERFORM test.throws('select public.drive_link_add(repeat(''g'', 40), ''g1'', null, ''../../x'', ''x'', ''text/plain'', ''https://drive.google.com/file/d/x/view'', null, null, ''ok'')', '23514', 'file id format enforced');
  PERFORM test.throws('insert into public.external_resource_links (project_id, external_id, name, mime_type, web_url) values (''g1'', ''fileProject0004'', ''x'', ''text/plain'', ''https://drive.google.com/x'')', '42501', 'no direct INSERT (metadata only from the server)');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'g-view@example.test');
  PERFORM test.ok((select count(*) from public.external_resource_links where project_id = 'g1') = 2, 'viewer reads the links');
  PERFORM test.throws('select public.drive_link_add(repeat(''g'', 40), ''g1'', null, ''fileProject0005'', ''x'', ''text/plain'', ''https://drive.google.com/file/d/x/view'', null, null, ''ok'')', '42501', 'viewer cannot add');
  DELETE FROM public.external_resource_links WHERE project_id = 'g1';
  PERFORM test.ok((select count(*) from public.external_resource_links where project_id = 'g1') = 2, 'viewer cannot remove (RLS)');
  PERFORM test.throws('select public.drive_link_refresh(repeat(''g'', 40), (select id from public.external_resource_links where card_id is null and project_id = ''g1''), ''x'', ''text/plain'', ''https://drive.google.com/file/d/x/view'', null, null, ''ok'')', '42501', 'viewer cannot write metadata');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'g-out@example.test');
  PERFORM test.ok((select count(*) from public.external_resource_links) = 0, 'outsider sees no link');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'g1') = 0, 'nor its events');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'g1' and action_type = 'drive_file_linked' and actor_id = current_setting('t.b')::uuid and source = 'app') = 2, 'one trusted event per persisted link (duplicate wrote none)');
  PERFORM test.ok((select details ->> 'name' from public.activity_logs where action_type = 'drive_file_linked' and card_id = 'g1-k1') = 'Rozpočet Q1'
              AND (select details ->> 'title' from public.activity_logs where action_type = 'drive_file_linked' and card_id = 'g1-k1') = 'Smlouva', 'task event names the file and the task');
  PERFORM test.ok((select child_rev from public.cards where id = 'g1-k1') >= 1, 'task link bumps the card child_rev (realtime signal for the drawer)');
  PERFORM test.ok((select linked_by_name from public.external_resource_links where card_id = 'g1-k1') = 'Editor Eva', 'linker shown by workspace name');
END $$;
DO $$
DECLARE l uuid; n int;
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'g-ed@example.test');
  SELECT id INTO l FROM public.external_resource_links WHERE project_id = 'g1' AND card_id IS NULL;
  SELECT count(*) INTO n FROM public.activity_logs WHERE project_id = 'g1';
  PERFORM test.ok(NOT public.drive_link_refresh(repeat('g', 40), l, 'Rozpočet Q1', 'application/vnd.google-apps.spreadsheet', 'https://docs.google.com/spreadsheets/d/fileProject0001/edit', null,
              (select modified_at from public.external_resource_links where id = l), 'ok'), 'unchanged metadata: no row change');
  PERFORM test.ok(public.drive_link_refresh(repeat('g', 40), l, 'Rozpočet Q1 v2', 'application/vnd.google-apps.spreadsheet', 'https://docs.google.com/spreadsheets/d/fileProject0001/edit', null, now(), 'trashed'), 'rename + trash stored');
  PERFORM test.ok((select name = 'Rozpočet Q1 v2' and provider_state = 'trashed' from public.external_resource_links where id = l), 'metadata updated');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'g1') = n, 'refreshes write no events');
END $$;

-- card moves to another project: its links follow (members of the old project lose them)
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  UPDATE public.cards SET column_id = 'g2-a' WHERE id = 'g1-k1';
  PERFORM test.ok((select project_id from public.external_resource_links where card_id = 'g1-k1') = 'g2', 'task link follows a cross-project move');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'g-ed@example.test');
  PERFORM test.ok((select count(*) from public.external_resource_links where card_id = 'g1-k1') = 0, 'editor of the old project no longer sees it');
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test'); UPDATE public.cards SET column_id = 'g1-a' WHERE id = 'g1-k1'; END $$;

-- removal: event; card deletion: cascade without unlink noise
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'g-ed@example.test');
  DELETE FROM public.external_resource_links WHERE project_id = 'g1' AND card_id IS NULL;
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'g1' and action_type = 'drive_file_unlinked' and actor_id = auth.uid()) = 1, 'editor removal: one unlink event');
  PERFORM public.drive_link_add(repeat('g', 40), 'g1', 'g1-k2', 'fileTask00000002', 'Příloha', 'application/pdf', 'https://drive.google.com/file/d/fileTask00000002/view', 10, now(), 'ok');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  DELETE FROM public.cards WHERE id = 'g1-k2';
  PERFORM test.ok((select count(*) from public.external_resource_links where card_id = 'g1-k2') = 0, 'task deletion removes its links');
  PERFORM test.ok((select count(*) from public.activity_logs where action_type = 'drive_file_unlinked' and details ->> 'name' = 'Příloha') = 0, 'no unlink events for a deleted task');
END $$;

-- membership removal and disconnect
DO $$
DECLARE m text;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'g-own@example.test');
  SELECT pm.member_id INTO m FROM public.project_members pm JOIN public.workspace_members wm ON wm.id = pm.member_id
  WHERE pm.project_id = 'g1' AND wm.profile_id = current_setting('t.b')::uuid;
  PERFORM public.remove_project_member('g1', m);
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'g-ed@example.test');
  PERFORM test.ok((select count(*) from public.external_resource_links where project_id = 'g1') = 0, 'removed member loses the links');
  PERFORM test.throws('select public.drive_link_add(repeat(''g'', 40), ''g1'', null, ''fileProject0009'', ''x'', ''text/plain'', ''https://drive.google.com/file/d/x/view'', null, null, ''ok'')', '42501', 'and cannot add');
  PERFORM test.ok((select count(*) from public.google_credentials_get(repeat('g', 40), 0)) = 1, 'their own Google connection is theirs and unaffected');
  PERFORM test.ok(public.google_disconnect(repeat('g', 40)), 'disconnect deletes the credentials');
  PERFORM test.ok((select count(*) from public.google_credentials_get(repeat('g', 40), 0)) = 0 AND (select count(*) from public.integration_audit where event = 'disconnected') = 1, 'gone, and audited');
  PERFORM test.ok(NOT public.google_disconnect(repeat('g', 40)), 'disconnect is idempotent');
END $$;

-- user deletion cascades the credentials
DO $$
BEGIN
  PERFORM test.reset();
  DELETE FROM auth.users WHERE id = current_setting('t.a')::uuid;
  PERFORM test.ok((select count(*) from public.google_connections where user_id = current_setting('t.a')::uuid) = 0, 'deleting the account deletes its Google credentials');
END $$;
