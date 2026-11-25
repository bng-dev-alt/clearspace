-- Google Calendar events (20261128001400). AUTOCOMMIT mode like 90-93: each DO block is one committed transaction (one request).
-- Roles: a = owner, b = editor, c = viewer, d = outsider, e = editor with Drive + Gmail only (no Calendar permission).
\set ON_ERROR_STOP 1

DO $$
DECLARE a uuid; b uuid; c uuid; d uuid; e uuid;
  cal text := 'https://www.googleapis.com/auth/calendar.events.owned.readonly';
BEGIN
  a := test.mkuser('k-own@example.test'); b := test.mkuser('k-ed@example.test'); c := test.mkuser('k-view@example.test');
  d := test.mkuser('k-out@example.test'); e := test.mkuser('k-gm@example.test');
  PERFORM set_config('t.a', a::text, false); PERFORM set_config('t.b', b::text, false); PERFORM set_config('t.c', c::text, false);
  PERFORM set_config('t.d', d::text, false); PERFORM set_config('t.e', e::text, false);
  INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('google', encode(sha256(convert_to(repeat('g', 40), 'UTF8')), 'hex'))
  ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;
  INSERT INTO public.google_connections (user_id, google_sub, google_email, scopes, refresh_token_enc) VALUES
    (a, '111', 'anna@example.test', ARRAY['openid', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.readonly', cal], 'v1.0000aaaa.a.b.c'),
    (b, '222', 'bohdan@example.test', ARRAY['openid', cal], 'v1.0000aaaa.a.b.c'),
    (c, '333', 'cyril@example.test', ARRAY['openid', cal], 'v1.0000aaaa.a.b.c'),
    (d, '444', 'dana@example.test', ARRAY['openid', cal], 'v1.0000aaaa.a.b.c'),
    (e, '555', 'emil@example.test', ARRAY['openid', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.readonly'], 'v1.0000aaaa.a.b.c');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'k-own@example.test');
  INSERT INTO public.projects (id, name) VALUES ('k1', 'Kalendář'), ('k2', 'Jiný');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('k1-a', 'k1', 'A', 0), ('k2-a', 'k2', 'A', 0);
  INSERT INTO public.project_members (project_id, member_id) VALUES ('k1', 'member-owner-' || current_setting('t.a')), ('k2', 'member-owner-' || current_setting('t.a'));
  INSERT INTO public.cards (id, column_id, title) VALUES ('k1-k1', 'k1-a', 'Kickoff'), ('k2-k1', 'k2-a', 'Cizí');
  SELECT * INTO r FROM public.create_project_invitation('k1', 'k-ed@example.test', 'member'); PERFORM set_config('t.tb', r.token, false);
  SELECT * INTO r FROM public.create_project_invitation('k1', 'k-view@example.test', 'viewer'); PERFORM set_config('t.tc', r.token, false);
  SELECT * INTO r FROM public.create_project_invitation('k1', 'k-gm@example.test', 'member'); PERFORM set_config('t.te', r.token, false);
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'k-ed@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tb'), 'Editor Eva'); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.c')::uuid, 'k-view@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tc'), 'Čtenář Cyril'); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.e')::uuid, 'k-gm@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.te'), 'Gmail Emil'); END $$;

-- ================= private sources are invisible; server RPCs need the secret; nothing anonymous =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'k-own@example.test');
  PERFORM test.throws('select * from public.calendar_link_sources', '42501', 'authenticated cannot read calendar_link_sources (event ids are private)');
  PERFORM test.throws('insert into public.calendar_link_sources (link_id, owner_user_id, google_sub, event_id) values (gen_random_uuid(), auth.uid(), ''1'', ''abcdef12'')', '42501', 'nor write them');
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('x', 40), 'k1', null, 'refXXXXXXXXXXXXXXXXXXXX', '111', 'evt0000001', null, 'T', now(), now(), false, null, false, 0, null, now(), 'ok')$q$, '42501', 'calendar_link_add with a wrong secret is refused');
  PERFORM test.throws($q$select * from public.calendar_link_source(null, gen_random_uuid())$q$, '42501', 'calendar_link_source without the secret is refused');
  PERFORM test.throws($q$select public.calendar_caller_sub()$q$, '42501', 'internal helper not callable by clients');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type, event_start, event_end, event_all_day, event_recurring, event_attendees) values ('k1', 'google_calendar_event', 'refYYYYYYYYYYYYYYYYYYYY', 'Podvrh', 'text/calendar', now(), now(), false, false, 0)$q$, '42501', 'clients cannot insert a Calendar link directly (no INSERT grant)');
  PERFORM test.act_as_anon();
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('g', 40), 'k1', null, 'refXXXXXXXXXXXXXXXXXXXX', '111', 'evt0000001', null, 'T', now(), now(), false, null, false, 0, null, now(), 'ok')$q$, '42501', 'anon cannot attach');
  PERFORM test.throws($q$select * from public.calendar_links_purge_mine(repeat('g', 40))$q$, '42501', 'anon cannot purge');
END $$;

-- ================= attach: owner, editor; refusals; duplicates (E7) =================
DO $$
DECLARE r record; r2 record; r3 record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'k-own@example.test');
  SELECT * INTO r FROM public.calendar_link_add(repeat('g', 40), 'k1', null, 'refAnnaEvent00000000001', '111', 'kickoffcorvane0001', null,
    'Kickoff Corvane', '2026-12-01T09:00:00Z', '2026-12-01T10:30:00Z', false, 'Europe/Prague', false, 4, 'Jana Dvořáková', '2026-11-20T08:00:00Z', 'ok');
  PERFORM set_config('t.l1', r.id::text, false);
  PERFORM test.ok(r.duplicate = false, 'owner attaches an event to the project');
  SELECT * INTO r2 FROM public.calendar_link_add(repeat('g', 40), 'k1', null, 'refAnnaEvent00000000001', '111', 'kickoffcorvane0001', null,
    'Kickoff Corvane', '2026-12-01T09:00:00Z', '2026-12-01T10:30:00Z', false, 'Europe/Prague', false, 4, 'Jana Dvořáková', '2026-11-20T08:00:00Z', 'ok');
  PERFORM test.ok(r2.id = r.id AND r2.duplicate, 'E7: the same event on the same project again returns the existing link (duplicate)');
  SELECT * INTO r3 FROM public.calendar_link_add(repeat('g', 40), 'k1', 'k1-k1', 'refAnnaEvent00000000001', '111', 'kickoffcorvane0001', null,
    'Kickoff Corvane', '2026-12-01T09:00:00Z', '2026-12-01T10:30:00Z', false, 'Europe/Prague', false, 4, 'Jana Dvořáková', '2026-11-20T08:00:00Z', 'ok');
  PERFORM test.ok(NOT r3.duplicate AND r3.id <> r.id, 'E7: a project-level and a task-level link of the same event may coexist');
  PERFORM set_config('t.l1t', r3.id::text, false);
  PERFORM test.ok((select web_url is null and mime_type = 'text/calendar' and provider = 'google_calendar_event' and event_attendees = 4
                     and event_organizer = 'Jana Dvořáková' and event_time_zone = 'Europe/Prague' and NOT event_all_day
                     from public.external_resource_links where id = r.id), 'shared row: no URL, no event id; title/times/flags/count/organizer only');
  PERFORM test.ok((select external_id from public.external_resource_links where id = r.id) !~ 'kickoff', 'external_id is the opaque ref, not the event id');
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('g', 40), 'k1', null, 'refAnnaWrongSub00000001', '222', 'evtother0001', null, 'T', now(), now(), false, null, false, 0, null, now(), 'ok')$q$,
    '42501', 'a Google account that is not the caller''s own is refused (no cross-account ids)');
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('g', 40), 'k1', null, 'refAnnaBadId00000000001', '111', '../etc/passwd', null, 'T', now(), now(), false, null, false, 0, null, now(), 'ok')$q$, '23514', 'a malformed event id is refused by the schema');
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('g', 40), 'k1', null, 'refAnnaBadTime000000001', '111', 'evtbadtime01', null, 'T', '2026-12-02T10:00:00Z', '2026-12-02T09:00:00Z', false, null, false, 0, null, now(), 'ok')$q$, '23514', 'an end before the start is refused');
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('g', 40), 'k1', null, 'refAnnaBadTz00000000001', '111', 'evtbadtz0001', null, 'T', now(), now(), false, 'Europe/Prague; drop', false, 0, null, now(), 'ok')$q$, '23514', 'a malformed time zone is refused');
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('g', 40), 'k1', null, 'refAnnaBadState00000001', '111', 'evtbadstate1', null, 'T', now(), now(), false, null, false, 0, null, now(), 'trashed')$q$, '23514', 'Calendar rows know only ok / deleted');
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('g', 40), 'k1', 'k2-k1', 'refAnnaOtherProj0000001', '111', 'evtotherprj1', null, 'T', now(), now(), false, null, false, 0, null, now(), 'ok')$q$, '42501', 'a task of another project is refused');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'k-ed@example.test');
  -- E1/E3: an occurrence of a recurring all-day series, linked to a task
  SELECT * INTO r FROM public.calendar_link_add(repeat('g', 40), 'k1', 'k1-k1', 'refBobOccur000000000001', '222', 'standupseries01_20261203', 'standupseries01',
    'Standup', '2026-12-03T00:00:00Z', '2026-12-04T00:00:00Z', true, null, true, 0, '@corvane.example', '2026-11-20T08:00:00Z', 'ok');
  PERFORM set_config('t.l2', r.id::text, false);
  PERFORM test.ok(NOT r.duplicate AND (select project_id from public.external_resource_links where id = r.id) = 'k1', 'editor attaches a recurring occurrence to a task');
  PERFORM test.ok((select event_all_day and event_recurring from public.external_resource_links where id = r.id), 'all-day + recurring flags stored');
  PERFORM test.ok((select child_rev from public.cards where id = 'k1-k1') >= 1, 'task link bumps child_rev (realtime refresh of the drawer)');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'k-view@example.test');
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('g', 40), 'k1', null, 'refViewer00000000000001', '333', 'evtviewer001', null, 'T', now(), now(), false, null, false, 0, null, now(), 'ok')$q$, '42501', 'viewer cannot attach');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'k-out@example.test');
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('g', 40), 'k1', null, 'refOutsider000000000001', '444', 'evtoutsid001', null, 'T', now(), now(), false, null, false, 0, null, now(), 'ok')$q$, '42501', 'outsider cannot attach');
  PERFORM test.act_as(current_setting('t.e')::uuid, 'k-gm@example.test');
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('g', 40), 'k1', null, 'refGmailOnly00000000001', '555', 'evtgmail0001', null, 'T', now(), now(), false, null, false, 0, null, now(), 'ok')$q$, '42501', 'E10: editor with Drive + Gmail but no Calendar permission cannot attach events');
END $$;

-- ================= schema rules (as superuser) =================
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type, web_url, event_start, event_end, event_all_day, event_recurring, event_attendees) values ('k1', 'google_calendar_event', 'refUrlNotAllowed0000001', 'x', 'text/calendar', 'https://calendar.google.com/event?eid=abc', now(), now(), false, false, 0)$q$, '23514', 'a Calendar row never stores a URL (htmlLink)');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type) values ('k1', 'google_calendar_event', 'refNoTimes0000000000001', 'x', 'text/calendar')$q$, '23514', 'a Calendar row needs start / end / flags');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type, web_url, event_start) values ('k1', 'google_drive', 'driveWithEvent1', 'x', 'application/pdf', 'https://drive.google.com/file/d/driveWithEvent1/view', now())$q$, '23514', 'event fields only on Calendar rows (Drive)');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type, event_attendees) values ('k1', 'gmail_message', 'refMailWithEvent0000001', 'x', 'message/rfc822', 3)$q$, '23514', 'event fields only on Calendar rows (Gmail)');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type, event_start, event_end, event_all_day, event_recurring, event_attendees, email_from) values ('k1', 'google_calendar_event', 'refEvtWithMail000000001', 'x', 'text/calendar', now(), now(), false, false, 0, 'x')$q$, '23514', 'e-mail fields never on Calendar rows');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type, event_start, event_end, event_all_day, event_recurring, event_attendees) values ('k1', 'google_calendar_event', 'refCtl00000000000000001', 'a' || chr(7), 'text/calendar', now(), now(), false, false, 0)$q$, '23514', 'control characters refused in the title');
  PERFORM test.throws($q$insert into public.external_resource_links (project_id, provider, external_id, name, mime_type, event_start, event_end, event_all_day, event_recurring, event_attendees) values ('k1', 'outlook_event', 'refProv0000000000000001', 'x', 'text/calendar', now(), now(), false, false, 0)$q$, '23514', 'unknown provider refused');
  PERFORM test.throws($q$insert into public.calendar_link_sources (link_id, owner_user_id, google_sub, calendar_id, event_id) values ((select id from public.external_resource_links where provider = 'google_calendar_event' limit 1), current_setting('t.a')::uuid, '111', 'someone@example.com', 'evtothercal1')$q$, '23514', 'MVP: only the primary calendar can be a source');
END $$;

-- ================= visibility: shared metadata to members only =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'k-view@example.test');
  PERFORM test.ok((select count(*) from public.external_resource_links where project_id = 'k1') = 3, 'viewer sees the shared metadata of the three links');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'k-out@example.test');
  PERFORM test.ok((select count(*) from public.external_resource_links where project_id = 'k1') = 0, 'outsider sees nothing');
END $$;

-- ================= private source: owner only, same account only =================
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'k-own@example.test');
  SELECT * INTO r FROM public.calendar_link_source(repeat('g', 40), current_setting('t.l1')::uuid);
  PERFORM test.ok(r.event_id = 'kickoffcorvane0001' AND r.same_account, 'owner gets the private source of THEIR link');
  PERFORM test.throws(format($q$select * from public.calendar_link_source(repeat('g', 40), %L)$q$, current_setting('t.l2')), '42501', 'owner of the project still cannot open an editor''s event (not theirs)');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'k-ed@example.test');
  PERFORM test.throws(format($q$select * from public.calendar_link_source(repeat('g', 40), %L)$q$, current_setting('t.l1')), '42501', 'editor cannot use the owner''s event');
  PERFORM test.act_as(current_setting('t.c')::uuid, 'k-view@example.test');
  PERFORM test.throws(format($q$select * from public.calendar_link_source(repeat('g', 40), %L)$q$, current_setting('t.l1')), '42501', 'viewer cannot');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'k-out@example.test');
  PERFORM test.throws(format($q$select * from public.calendar_link_source(repeat('g', 40), %L)$q$, current_setting('t.l1')), '42501', 'outsider cannot');
  PERFORM test.throws($q$select * from public.calendar_link_source(repeat('g', 40), gen_random_uuid())$q$, '42501', 'an unknown link id gives the same refusal (no oracle)');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.reset();
  UPDATE public.google_connections SET google_sub = '999' WHERE user_id = current_setting('t.a')::uuid;   -- owner switched Google account
  PERFORM test.act_as(current_setting('t.a')::uuid, 'k-own@example.test');
  SELECT * INTO r FROM public.calendar_link_source(repeat('g', 40), current_setting('t.l1')::uuid);
  PERFORM test.ok(r.same_account = false, 'another connected Google account: the server must not use the stored id with it');
  PERFORM test.throws(format($q$select public.calendar_link_refresh(repeat('g', 40), %L, 'X', null, null, null, null, null, null, null, null, 'ok')$q$, current_setting('t.l1')), '42501', 'and cannot refresh it');
  PERFORM test.reset();
  UPDATE public.google_connections SET google_sub = '111' WHERE user_id = current_setting('t.a')::uuid;
END $$;

-- ================= refresh (E5: rescheduled / cancelled): owner only; signal-only, no event =================
DO $$
DECLARE n bigint;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'k-own@example.test');
  SELECT count(*) INTO n FROM public.activity_logs WHERE project_id = 'k1';
  PERFORM test.ok(public.calendar_link_refresh(repeat('g', 40), current_setting('t.l1')::uuid, 'Kickoff Corvane (přesunuto)', '2026-12-02T13:00:00Z', '2026-12-02T14:00:00Z', false, 'Europe/Prague', false, 5, 'Jana Dvořáková', '2026-11-21T08:00:00Z', 'ok'), 'E5: rescheduled event stored');
  PERFORM test.ok((select name = 'Kickoff Corvane (přesunuto)' and event_start = '2026-12-02T13:00:00Z' and event_attendees = 5 from public.external_resource_links where id = current_setting('t.l1')::uuid), 'new title / time / count stored');
  PERFORM test.ok(NOT public.calendar_link_refresh(repeat('g', 40), current_setting('t.l1')::uuid, 'Kickoff Corvane (přesunuto)', '2026-12-02T13:00:00Z', '2026-12-02T14:00:00Z', false, 'Europe/Prague', false, 5, 'Jana Dvořáková', '2026-11-21T08:00:00Z', 'ok'), 'unchanged refresh changes nothing');
  PERFORM test.ok(public.calendar_link_refresh(repeat('g', 40), current_setting('t.l1')::uuid, null, null, null, null, null, null, null, null, null, 'deleted'), 'E5: cancelled / deleted in the owner''s calendar is recorded');
  PERFORM test.ok((select provider_state = 'deleted' and event_organizer = 'Jana Dvořáková' and event_time_zone = 'Europe/Prague' from public.external_resource_links where id = current_setting('t.l1')::uuid), 'a state-only refresh keeps the last known metadata');
  PERFORM test.throws(format($q$select public.calendar_link_refresh(repeat('g', 40), %L, null, null, null, null, null, null, null, null, null, 'trashed')$q$, current_setting('t.l1')), '22023', 'unknown state refused');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'k1') = n, 'metadata refreshes write no events');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'k-ed@example.test');
  PERFORM test.throws(format($q$select public.calendar_link_refresh(repeat('g', 40), %L, 'Přepsáno', null, null, null, null, null, null, null, null, 'ok')$q$, current_setting('t.l1')), '42501', 'editor cannot refresh (overwrite) someone else''s event metadata');
END $$;

-- ================= events: no title, trusted actor =================
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'k1' and action_type = 'event_linked' and source = 'app') = 3, 'one trusted event per persisted link (duplicate wrote none)');
  PERFORM test.ok((select bool_and(NOT (details ? 'name') AND NOT (details ? 'kind') AND details ? 'link_id') from public.activity_logs where action_type = 'event_linked'), 'event-link activity carries no event title (ids only)');
  PERFORM test.ok((select count(*) from public.activity_logs where action_type = 'event_linked' and card_id = 'k1-k1' and details ->> 'title' = 'Kickoff') = 2, 'task events name the task');
  PERFORM test.ok((select count(*) from public.activity_logs where action_type IN ('drive_file_linked', 'email_linked') and project_id = 'k1') = 0, 'not reported as a Drive file or an e-mail');
END $$;

-- ================= removal: editor yes (association only), viewer no =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'k-view@example.test');
  DELETE FROM public.external_resource_links WHERE id = current_setting('t.l1')::uuid;
  PERFORM test.act_as(current_setting('t.d')::uuid, 'k-out@example.test');
  DELETE FROM public.external_resource_links WHERE id = current_setting('t.l1')::uuid;
  PERFORM test.reset();
  PERFORM test.ok((select count(*) from public.external_resource_links where id = current_setting('t.l1')::uuid) = 1, 'viewer and outsider cannot remove (RLS: 0 rows deleted)');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'k-ed@example.test');
  DELETE FROM public.external_resource_links WHERE id = current_setting('t.l1')::uuid;
  PERFORM test.reset();
  PERFORM test.ok((select count(*) from public.external_resource_links where id = current_setting('t.l1')::uuid) = 0, 'editor removes the association');
  PERFORM test.ok((select count(*) from public.calendar_link_sources where link_id = current_setting('t.l1')::uuid) = 0, 'the private source goes with it');
  PERFORM test.ok((select count(*) from public.activity_logs where action_type = 'event_unlinked' and project_id = 'k1' and NOT (details ? 'name')) = 1, 'one unlink event, without title');
END $$;

-- ================= purge on request (incl. after demotion / removal) =================
DO $$
DECLARE mb text;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'k-own@example.test');
  SELECT pm.member_id INTO mb FROM public.project_members pm JOIN public.workspace_members wm ON wm.id = pm.member_id
  WHERE pm.project_id = 'k1' AND wm.profile_id = current_setting('t.b')::uuid;
  PERFORM set_config('t.mb', mb, false);
  PERFORM public.set_project_member('k1', mb, 'viewer');
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'k-ed@example.test');
  SELECT * INTO r FROM public.calendar_links_purge_mine(repeat('g', 40));
  PERFORM test.ok(r.removed = 0 AND r.skipped = 1, 'demoted to Čtenář: own link kept by the viewer guard, reported as skipped');
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.a')::uuid, 'k-own@example.test'); PERFORM public.remove_project_member('k1', current_setting('t.mb')); END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'k-ed@example.test');
  PERFORM test.ok((select count(*) from public.external_resource_links where project_id = 'k1') = 0, 'removed member no longer sees the project''s events');
  PERFORM test.throws(format($q$select * from public.calendar_link_source(repeat('g', 40), %L)$q$, current_setting('t.l2')), '42501', 'removed member cannot use even their own link''s source');
  SELECT * INTO r FROM public.calendar_links_purge_mine(repeat('g', 40));
  PERFORM test.ok(r.removed = 1 AND r.skipped = 0, 'but can still delete the events they linked (data deletion on request)');
  PERFORM test.reset();
  PERFORM test.ok((select count(*) from public.external_resource_links where id = current_setting('t.l2')::uuid) = 0, 'link gone');
  PERFORM test.ok((select count(*) from public.external_resource_links where id = current_setting('t.l1t')::uuid) = 1, 'the owner''s own task link is untouched by another user''s purge');
END $$;

-- ================= per-service permission (Calendar off in ClearSpace; Drive + Gmail untouched) (E10) =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'k-own@example.test');
  PERFORM test.ok(public.google_service_remove(repeat('g', 40), 'https://www.googleapis.com/auth/calendar.events.owned.readonly'), 'Calendar removed from what ClearSpace uses');
  PERFORM test.ok(NOT public.google_service_remove(repeat('g', 40), 'https://www.googleapis.com/auth/calendar.events.owned.readonly'), 'idempotent');
  PERFORM test.ok((select scopes from public.google_connection_status()) = ARRAY['openid', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.readonly'], 'Drive + Gmail scopes kept');
  PERFORM test.ok((select count(*) from public.integration_audit where user_id = auth.uid() and event = 'service_removed' and detail = 'calendar') = 1, 'audited as calendar (own row readable)');
  PERFORM test.throws($q$select * from public.calendar_link_add(repeat('g', 40), 'k1', null, 'refAfterRemoval00000001', '111', 'evtafterrem1', null, 'T', now(), now(), false, null, false, 0, null, now(), 'ok')$q$, '42501', 'after removal no new event can be attached');
  PERFORM test.throws(format($q$select public.calendar_link_refresh(repeat('g', 40), %L, 'X', null, null, null, null, null, null, null, null, 'ok')$q$, current_setting('t.l1t')), '42501', 'nor refreshed');
  PERFORM public.google_service_audit(repeat('g', 40), 'service_added', 'calendar');
  PERFORM public.google_service_audit(repeat('g', 40), 'scope_denied', 'calendar');
  PERFORM test.throws($q$select public.google_service_audit(repeat('g', 40), 'service_added', 'outlook')$q$, '22023', 'unknown service refused');
  -- RUN 03C code keeps working on 1400: Gmail and Drive values still accepted
  PERFORM test.ok(public.google_service_remove(repeat('g', 40), 'https://www.googleapis.com/auth/gmail.readonly'), 'Gmail removal unchanged');
  PERFORM public.google_service_audit(repeat('g', 40), 'service_added', 'gmail');
  PERFORM test.ok((select count(*) from public.integration_audit where user_id = auth.uid() and detail = 'gmail') = 2, 'Gmail audit unchanged');
END $$;

-- ================= Gmail + Drive compatibility (RUN 02/03 RPCs unchanged) =================
DO $$
DECLARE r record;
BEGIN
  PERFORM test.reset();
  UPDATE public.google_connections SET scopes = scopes || ARRAY['https://www.googleapis.com/auth/gmail.readonly'] WHERE user_id = current_setting('t.a')::uuid;
  PERFORM test.act_as(current_setting('t.a')::uuid, 'k-own@example.test');
  SELECT * INTO r FROM public.gmail_link_add(repeat('g', 40), 'k1', null, 'thread', 'refCompatGmail000000001', '111', '18c3a5e000000000', '18c3a5e000000000', 'S', 'F', now(), 1, null, 'ok');
  PERFORM test.ok(NOT r.duplicate, 'Gmail attach works unchanged on 1400');
  SELECT * INTO r FROM public.drive_link_add(repeat('g', 40), 'k1', null, 'driveCompat00001', 'Rozpočet', 'application/pdf', 'https://drive.google.com/file/d/driveCompat00001/view', 10, now(), 'ok');
  PERFORM test.ok(NOT r.duplicate, 'Drive attach works unchanged on 1400');
  PERFORM test.ok((select count(*) from public.activity_logs where action_type = 'email_linked' and project_id = 'k1') = 1
              AND (select count(*) from public.activity_logs where action_type = 'drive_file_linked' and details ->> 'name' = 'Rozpočet') = 1, 'Gmail / Drive events unchanged');
END $$;
