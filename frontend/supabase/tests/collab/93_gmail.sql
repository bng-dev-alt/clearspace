-- Gmail resources (20261127001300). AUTOCOMMIT mode like 90-92: each DO block is one committed transaction (one request).
-- Roles: a = owner, b = editor, c = viewer, d = outsider, e = editor with Drive only (no Gmail permission).
\set ON_ERROR_STOP 1

DO $$
DECLARE a uuid; b uuid; c uuid; d uuid; e uuid;
BEGIN
  a := test.mkuser('m-own@example.test'); b := test.mkuser('m-ed@example.test'); c := test.mkuser('m-view@example.test');
  d := test.mkuser('m-out@example.test'); e := test.mkuser('m-drv@example.test');
  PERFORM set_config('t.a', a::text, false); PERFORM set_config('t.b', b::text, false); PERFORM set_config('t.c', c::text, false);
  PERFORM set_config('t.d', d::text, false); PERFORM set_config('t.e', e::text, false);
  INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('google', encode(sha256(convert_to(repeat('g', 40), 'UTF8')), 'hex'))
  ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;
  -- connections (written directly as the server would; tokens are opaque envelopes here)
  INSERT INTO public.google_connections (user_id, google_sub, google_email, scopes, refresh_token_enc) VALUES
    (a, '111', 'anna@example.test', ARRAY['openid', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.readonly'], 'v1.0000aaaa.a.b.c'),
    (b, '222', 'bohdan@example.test', ARRAY['openid', 'https://www.googleapis.com/auth/gmail.readonly'], 'v1.0000aaaa.a.b.c'),
    (c, '333', 'cyril@example.test', ARRAY['openid', 'https://www.googleapis.com/auth/gmail.readonly'], 'v1.0000aaaa.a.b.c'),
    (d, '444', 'dana@example.test', ARRAY['openid', 'https://www.googleapis.com/auth/gmail.readonly'], 'v1.0000aaaa.a.b.c'),
    (e, '555', 'emil@example.test', ARRAY['openid', 'https://www.googleapis.com/auth/drive.file'], 'v1.0000aaaa.a.b.c');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'm-own@example.test');
  INSERT INTO public.projects (id, name) VALUES ('m1', 'Gmail'), ('m2', 'Jiný');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('m1-a', 'm1', 'A', 0), ('m2-a', 'm2', 'A', 0);
  INSERT INTO public.project_members (project_id, member_id) VALUES ('m1', 'member-owner-' || current_setting('t.a')), ('m2', 'member-owner-' || current_setting('t.a'));
  INSERT INTO public.cards (id, column_id, title) VALUES ('m1-k1', 'm1-a', 'Smlouva'), ('m2-k1', 'm2-a', 'Cizí');
  SELECT * INTO r FROM public.create_project_invitation('m1', 'm-ed@example.test', 'member'); PERFORM set_config('t.tb', r.token, false);
  SELECT * INTO r FROM public.create_project_invitation('m1', 'm-view@example.test', 'viewer'); PERFORM set_config('t.tc', r.token, false);
  SELECT * INTO r FROM public.create_project_invitation('m1', 'm-drv@example.test', 'member'); PERFORM set_config('t.te', r.token, false);
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'm-ed@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tb'), 'Editor Eva'); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.c')::uuid, 'm-view@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tc'), 'Čtenář Cyril'); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.e')::uuid, 'm-drv@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.te'), 'Drive Emil'); END $$;

-- ================= private sources are invisible; server RPCs need the secret; nothing anonymous =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'm-own@example.test');
  PERFORM test.throws('select * from public.gmail_link_sources', '42501', 'authenticated cannot read gmail_link_sources (Gmail ids are private)');
  PERFORM test.throws('insert into public.gmail_link_sources (link_id, owner_user_id, google_sub, kind, gmail_id, thread_id) values (gen_random_uuid(), auth.uid(), ''1'', ''message'', ''abcdef12'', ''abcdef12'')', '42501', 'nor write them');
  PERFORM test.throws($q$select * from public.gmail_link_add(repeat('x', 40), 'm1', null, 'thread', 'refXXXXXXXXXXXXXXXXXXXX', '111', '18c3a5e000000000', '18c3a5e000000000', 'S', 'F', now(), 1, null, 'ok')$q$, '42501', 'gmail_link_add with a wrong secret is refused');
  PERFORM test.throws($q$select * from public.gmail_link_source(null, gen_random_uuid())$q$, '42501', 'gmail_link_source without the secret is refused');
  PERFORM test.throws($q$select public.gmail_caller_sub()$q$, '42501', 'internal helper not callable by clients');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type) values ('m1', 'gmail_message', 'refYYYYYYYYYYYYYYYYYYYY', 'Podvrh', 'message/rfc822')$q$, '42501', 'clients cannot insert a Gmail link directly (no INSERT grant)');
  PERFORM test.act_as_anon();
  PERFORM test.throws($q$select * from public.gmail_link_add(repeat('g', 40), 'm1', null, 'thread', 'refXXXXXXXXXXXXXXXXXXXX', '111', '18c3a5e000000000', '18c3a5e000000000', 'S', 'F', now(), 1, null, 'ok')$q$, '42501', 'anon cannot attach');
  PERFORM test.throws($q$select * from public.gmail_links_purge_mine(repeat('g', 40))$q$, '42501', 'anon cannot purge');
END $$;

-- ================= attach: owner, editor; refusals =================
DO $$
DECLARE r record; r2 record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'm-own@example.test');
  SELECT * INTO r FROM public.gmail_link_add(repeat('g', 40), 'm1', null, 'thread', 'refAnnaThread0000000001', '111', '18c3a5e000000000', '18c3a5e000000000',
    'Nabídka na redesign portálu', 'Jana Dvořáková', '2026-11-12T09:15:00Z', 3, null, 'ok');
  PERFORM set_config('t.l1', r.id::text, false);
  PERFORM test.ok(r.duplicate = false, 'owner attaches a thread to the project');
  SELECT * INTO r2 FROM public.gmail_link_add(repeat('g', 40), 'm1', null, 'thread', 'refAnnaThread0000000001', '111', '18c3a5e000000000', '18c3a5e000000000',
    'Nabídka na redesign portálu', 'Jana Dvořáková', '2026-11-12T09:15:00Z', 3, null, 'ok');
  PERFORM test.ok(r2.id = r.id AND r2.duplicate, 'the same item again returns the existing link (duplicate)');
  PERFORM test.ok((select web_url is null and mime_type = 'message/rfc822' and provider = 'gmail_thread' and email_count = 3 and email_from = 'Jana Dvořáková'
                     from public.external_resource_links where id = r.id), 'shared row: no URL, no Gmail id; subject/sender/date/count only');
  PERFORM test.ok((select external_id from public.external_resource_links where id = r.id) !~ '18c3a5e', 'external_id is the opaque ref, not the Gmail id');
  PERFORM test.throws($q$select * from public.gmail_link_add(repeat('g', 40), 'm1', null, 'message', 'refAnnaWrongSub00000001', '222', '18c3a5e000000001', '18c3a5e000000000', 'S', 'F', now(), 1, null, 'ok')$q$,
    '42501', 'a Google account that is not the caller''s own is refused (no cross-account ids)');
  PERFORM test.throws($q$select * from public.gmail_link_add(repeat('g', 40), 'm1', null, 'mail', 'refAnnaBadKind000000001', '111', '18c3a5e000000001', '18c3a5e000000000', 'S', 'F', now(), 1, null, 'ok')$q$, '22023', 'unknown kind refused');
  PERFORM test.throws($q$select * from public.gmail_link_add(repeat('g', 40), 'm1', null, 'message', 'refAnnaBadId00000000001', '111', '../etc/passwd', '18c3a5e000000000', 'S', 'F', now(), 1, null, 'ok')$q$, '23514', 'a non-hex Gmail id is refused by the schema');
  PERFORM test.throws($q$select * from public.gmail_link_add(repeat('g', 40), 'm1', 'm2-k1', 'message', 'refAnnaOtherProj0000001', '111', '18c3a5e000000001', '18c3a5e000000000', 'S', 'F', now(), 1, null, 'ok')$q$, '42501', 'a task of another project is refused');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'm-ed@example.test');
  SELECT * INTO r FROM public.gmail_link_add(repeat('g', 40), 'm1', 'm1-k1', 'message', 'refBobMessage0000000001', '222', '18c3a5e0000000aa', '18c3a5e0000000aa',
    'Faktura 2026-118', '@corvane.example', '2026-11-13T09:00:00Z', 1, null, 'ok');
  PERFORM set_config('t.l2', r.id::text, false);
  PERFORM test.ok(NOT r.duplicate AND (select project_id from public.external_resource_links where id = r.id) = 'm1', 'editor attaches an e-mail to a task');
  PERFORM test.ok((select child_rev from public.cards where id = 'm1-k1') >= 1, 'task link bumps child_rev (realtime refresh of the drawer)');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'm-view@example.test');
  PERFORM test.throws($q$select * from public.gmail_link_add(repeat('g', 40), 'm1', null, 'message', 'refViewer00000000000001', '333', '18c3a5e0000000bb', '18c3a5e0000000bb', 'S', 'F', now(), 1, null, 'ok')$q$, '42501', 'viewer cannot attach');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'm-out@example.test');
  PERFORM test.throws($q$select * from public.gmail_link_add(repeat('g', 40), 'm1', null, 'message', 'refOutsider000000000001', '444', '18c3a5e0000000cc', '18c3a5e0000000cc', 'S', 'F', now(), 1, null, 'ok')$q$, '42501', 'outsider cannot attach');
  PERFORM test.act_as(current_setting('t.e')::uuid, 'm-drv@example.test');
  PERFORM test.throws($q$select * from public.gmail_link_add(repeat('g', 40), 'm1', null, 'message', 'refDriveOnly00000000001', '555', '18c3a5e0000000dd', '18c3a5e0000000dd', 'S', 'F', now(), 1, null, 'ok')$q$, '42501', 'editor with Drive only (no Gmail permission) cannot attach e-mails');
END $$;

-- ================= schema rules (as superuser) =================
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type, web_url) values ('m1', 'gmail_message', 'refUrlNotAllowed0000001', 'x', 'message/rfc822', 'https://mail.google.com/mail/u/0/#all/abc')$q$, '23514', 'a Gmail row never stores a URL');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type) values ('m1', 'google_drive', 'driveNoUrl000001', 'x', 'application/pdf')$q$, '23514', 'a Drive row still needs its Google URL');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type, web_url, email_from) values ('m1', 'google_drive', 'driveWithMail01', 'x', 'application/pdf', 'https://drive.google.com/file/d/driveWithMail01/view', 'x')$q$, '23514', 'e-mail fields only on Gmail rows');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type) values ('m1', 'gmail_message', 'refCtl00000000000000001', 'a' || chr(7), 'message/rfc822')$q$, '23514', 'control characters refused in the subject');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type) values ('m1', 'outlook', 'refProv0000000000000001', 'x', 'message/rfc822')$q$, '23514', 'unknown provider refused');
  PERFORM test.ok((select count(*) from public.integration_audit) >= 0 AND (select count(*) from public.external_resource_links where provider = 'google_drive') = 0, 'Drive rows untouched (none in this project)');
END $$;

-- ================= visibility: shared metadata to members only =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'm-view@example.test');
  PERFORM test.ok((select count(*) from public.external_resource_links where project_id = 'm1') = 2, 'viewer sees the shared metadata of both links');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'm-out@example.test');
  PERFORM test.ok((select count(*) from public.external_resource_links where project_id = 'm1') = 0, 'outsider sees nothing');
END $$;

-- ================= private source: owner only, same account only =================
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'm-own@example.test');
  SELECT * INTO r FROM public.gmail_link_source(repeat('g', 40), current_setting('t.l1')::uuid);
  PERFORM test.ok(r.kind = 'thread' AND r.gmail_id = '18c3a5e000000000' AND r.same_account, 'owner gets the private source of THEIR link');
  PERFORM test.throws(format($q$select * from public.gmail_link_source(repeat('g', 40), %L)$q$, current_setting('t.l2')), '42501', 'owner of the project still cannot open an editor''s e-mail (not theirs)');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'm-ed@example.test');
  PERFORM test.throws(format($q$select * from public.gmail_link_source(repeat('g', 40), %L)$q$, current_setting('t.l1')), '42501', 'editor cannot use the owner''s e-mail');
  PERFORM test.act_as(current_setting('t.c')::uuid, 'm-view@example.test');
  PERFORM test.throws(format($q$select * from public.gmail_link_source(repeat('g', 40), %L)$q$, current_setting('t.l1')), '42501', 'viewer cannot');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'm-out@example.test');
  PERFORM test.throws(format($q$select * from public.gmail_link_source(repeat('g', 40), %L)$q$, current_setting('t.l1')), '42501', 'outsider cannot');
  PERFORM test.throws($q$select * from public.gmail_link_source(repeat('g', 40), gen_random_uuid())$q$, '42501', 'an unknown link id gives the same refusal (no oracle)');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.reset();
  UPDATE public.google_connections SET google_sub = '999' WHERE user_id = current_setting('t.a')::uuid;   -- owner switched Google account
  PERFORM test.act_as(current_setting('t.a')::uuid, 'm-own@example.test');
  SELECT * INTO r FROM public.gmail_link_source(repeat('g', 40), current_setting('t.l1')::uuid);
  PERFORM test.ok(r.same_account = false, 'another connected Google account: the server must not use the stored id with it');
  PERFORM test.throws(format($q$select public.gmail_link_refresh(repeat('g', 40), %L, 'X', null, null, null, null, 'ok')$q$, current_setting('t.l1')), '42501', 'and cannot refresh it');
  PERFORM test.reset();
  UPDATE public.google_connections SET google_sub = '111' WHERE user_id = current_setting('t.a')::uuid;
END $$;

-- ================= refresh: owner only; signal-only, no event =================
DO $$
DECLARE n bigint;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'm-own@example.test');
  SELECT count(*) INTO n FROM public.activity_logs WHERE project_id = 'm1';
  PERFORM test.ok(public.gmail_link_refresh(repeat('g', 40), current_setting('t.l1')::uuid, 'Nabídka (aktualizováno)', null, null, 4, 2, 'ok'), 'owner refresh stores changed metadata');
  PERFORM test.ok((select name = 'Nabídka (aktualizováno)' and email_count = 4 and email_attachments = 2 from public.external_resource_links where id = current_setting('t.l1')::uuid), 'new subject / count / attachment count stored');
  PERFORM test.ok(NOT public.gmail_link_refresh(repeat('g', 40), current_setting('t.l1')::uuid, 'Nabídka (aktualizováno)', null, null, 4, 2, 'ok'), 'unchanged refresh changes nothing');
  PERFORM test.ok(public.gmail_link_refresh(repeat('g', 40), current_setting('t.l1')::uuid, null, null, null, null, null, 'deleted'), 'deleted in the owner''s mailbox is recorded');
  PERFORM test.throws(format($q$select public.gmail_link_refresh(repeat('g', 40), %L, null, null, null, null, null, 'gone')$q$, current_setting('t.l1')), '22023', 'unknown state refused');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'm1') = n, 'metadata refreshes write no events');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'm-ed@example.test');
  PERFORM test.throws(format($q$select public.gmail_link_refresh(repeat('g', 40), %L, 'Přepsáno', null, null, null, null, 'ok')$q$, current_setting('t.l1')), '42501', 'editor cannot refresh (overwrite) someone else''s e-mail metadata');
END $$;

-- ================= events: no subject, trusted actor =================
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'm1' and action_type = 'email_linked' and source = 'app') = 2, 'one trusted event per persisted link (duplicate wrote none)');
  PERFORM test.ok((select bool_and(NOT (details ? 'name') AND details ->> 'kind' IN ('message', 'thread')) from public.activity_logs where action_type = 'email_linked'), 'e-mail events carry no subject (kind + ids only)');
  PERFORM test.ok((select details ->> 'title' from public.activity_logs where action_type = 'email_linked' and card_id = 'm1-k1') = 'Smlouva', 'task event names the task');
  PERFORM test.ok((select count(*) from public.activity_logs where action_type = 'drive_file_linked' and project_id = 'm1') = 0, 'not reported as a Drive file');
END $$;

-- ================= removal: editor yes (association only), viewer no =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'm-view@example.test');
  DELETE FROM public.external_resource_links WHERE id = current_setting('t.l1')::uuid;   -- RLS DELETE: can_edit_project -> 0 rows
  PERFORM test.act_as(current_setting('t.d')::uuid, 'm-out@example.test');
  DELETE FROM public.external_resource_links WHERE id = current_setting('t.l1')::uuid;
  PERFORM test.reset();
  PERFORM test.ok((select count(*) from public.external_resource_links where id = current_setting('t.l1')::uuid) = 1, 'viewer and outsider cannot remove (RLS: 0 rows deleted)');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'm-ed@example.test');
  DELETE FROM public.external_resource_links WHERE id = current_setting('t.l1')::uuid;
  PERFORM test.reset();
  PERFORM test.ok((select count(*) from public.external_resource_links where id = current_setting('t.l1')::uuid) = 0, 'editor removes the association');
  PERFORM test.ok((select count(*) from public.gmail_link_sources where link_id = current_setting('t.l1')::uuid) = 0, 'the private source goes with it');
  PERFORM test.ok((select count(*) from public.activity_logs where action_type = 'email_unlinked' and project_id = 'm1' and NOT (details ? 'name')) = 1, 'one unlink event, without subject');
END $$;

-- ================= purge on request (incl. after demotion / removal) =================
DO $$
DECLARE r record; mb text;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'm-own@example.test');
  SELECT pm.member_id INTO mb FROM public.project_members pm JOIN public.workspace_members wm ON wm.id = pm.member_id
  WHERE pm.project_id = 'm1' AND wm.profile_id = current_setting('t.b')::uuid;
  PERFORM set_config('t.mb', mb, false);
  PERFORM public.set_project_member('m1', mb, 'viewer');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'm-ed@example.test');
  SELECT * INTO r FROM public.gmail_links_purge_mine(repeat('g', 40));
  PERFORM test.ok(r.removed = 0 AND r.skipped = 1, 'demoted to Čtenář: own link kept by the viewer guard, reported as skipped');
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.a')::uuid, 'm-own@example.test'); PERFORM public.remove_project_member('m1', current_setting('t.mb')); END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'm-ed@example.test');
  PERFORM test.ok((select count(*) from public.external_resource_links where project_id = 'm1') = 0, 'removed member no longer sees the project''s e-mails');
  PERFORM test.throws(format($q$select * from public.gmail_link_source(repeat('g', 40), %L)$q$, current_setting('t.l2')), '42501', 'removed member cannot use even their own link''s source');
  SELECT * INTO r FROM public.gmail_links_purge_mine(repeat('g', 40));
  PERFORM test.ok(r.removed = 1 AND r.skipped = 0, 'but can still delete the e-mails they linked (data deletion on request)');
  PERFORM test.reset();
  PERFORM test.ok((select count(*) from public.external_resource_links where id = current_setting('t.l2')::uuid) = 0, 'link gone');
END $$;

-- ================= per-service permission (Gmail off in ClearSpace; Drive untouched) =================
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'm-own@example.test');
  SELECT * INTO r FROM public.google_connection_sub(repeat('g', 40), '222');
  PERFORM test.ok(r.own_sub = '111' AND r.candidate_in_use, 'own account + "this Google account is connected somewhere" (do not revoke it)');
  SELECT * INTO r FROM public.google_connection_sub(repeat('g', 40), '777');
  PERFORM test.ok(NOT r.candidate_in_use, 'an unconnected Google account may be revoked');
  PERFORM test.throws($q$select public.google_service_remove(repeat('g', 40), 'openid')$q$, '22023', 'identity scopes cannot be removed this way');
  PERFORM test.ok(public.google_service_remove(repeat('g', 40), 'https://www.googleapis.com/auth/gmail.readonly'), 'Gmail removed from what ClearSpace uses');
  PERFORM test.ok(NOT public.google_service_remove(repeat('g', 40), 'https://www.googleapis.com/auth/gmail.readonly'), 'idempotent');
  PERFORM test.ok((select scopes from public.google_connection_status()) = ARRAY['openid', 'https://www.googleapis.com/auth/drive.file'], 'Drive scope kept');
  PERFORM test.ok((select count(*) from public.integration_audit where user_id = auth.uid() and event = 'service_removed' and detail = 'gmail') = 1, 'audited (own row readable)');
  PERFORM test.throws($q$select * from public.gmail_link_add(repeat('g', 40), 'm1', null, 'message', 'refAfterRemoval00000001', '111', '18c3a5e000000005', '18c3a5e000000005', 'S', 'F', now(), 1, null, 'ok')$q$, '42501', 'after removal no new e-mail can be attached');
  PERFORM public.google_service_audit(repeat('g', 40), 'service_added', 'gmail');
  PERFORM test.throws($q$select public.google_service_audit(repeat('g', 40), 'connected', 'gmail')$q$, '22023', 'only per-service events through google_service_audit');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'm-ed@example.test');
  PERFORM test.ok((select count(*) from public.integration_audit where user_id = current_setting('t.a')::uuid) = 0, 'audit rows of others are invisible');
END $$;

-- ================= Drive compatibility (RUN 02 RPCs unchanged) =================
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'm-own@example.test');
  SELECT * INTO r FROM public.drive_link_add(repeat('g', 40), 'm1', null, 'driveCompat00001', 'Rozpočet', 'application/pdf', 'https://drive.google.com/file/d/driveCompat00001/view', 10, now(), 'ok');
  PERFORM test.ok(NOT r.duplicate, 'Drive attach works unchanged');
  PERFORM test.ok((select count(*) from public.activity_logs where action_type = 'drive_file_linked' and details ->> 'name' = 'Rozpočet') = 1, 'Drive events still name the file');
  PERFORM test.throws(format($q$select public.drive_link_refresh(repeat('g', 40), %L, 'x', 'application/pdf', 'https://evil.example/x', 1, now(), 'ok')$q$, r.id), '23514', 'Drive URL rule still enforced');
END $$;
