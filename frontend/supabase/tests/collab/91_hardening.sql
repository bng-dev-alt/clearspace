-- Collaboration hardening (20261125001100). AUTOCOMMIT mode like 90_collaboration.sql: each DO block is
-- one committed transaction (one request), so deferred triggers fire as in production.
\set ON_ERROR_STOP 1

DO $$
DECLARE a uuid; b uuid; c uuid; d uuid;
BEGIN
  a := test.mkuser('h-own@example.test'); b := test.mkuser('h-ed@example.test');
  c := test.mkuser('h-view@example.test'); d := test.mkuser('h-out@example.test');
  PERFORM set_config('t.a', a::text, false); PERFORM set_config('t.b', b::text, false);
  PERFORM set_config('t.c', c::text, false); PERFORM set_config('t.d', d::text, false);
  INSERT INTO public.server_trust (purpose, secret_sha256)
  VALUES ('email', encode(sha256(convert_to(repeat('e', 40), 'UTF8')), 'hex'))
  ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;
END $$;

-- Owner A: two projects (P1 shared with B and C, P2 shared with nobody) and private contacts
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  INSERT INTO public.projects (id, name) VALUES ('h1', 'Sdílený'), ('h2', 'Soukromý');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('h1-a', 'h1', 'A', 0), ('h1-b', 'h1', 'B', 1), ('h2-a', 'h2', 'A', 0);
  INSERT INTO public.project_members (project_id, member_id) VALUES ('h1', 'member-owner-' || current_setting('t.a')), ('h2', 'member-owner-' || current_setting('t.a'));
  INSERT INTO public.workspace_members (id, owner_id, full_name, initials, email) VALUES
    ('h-secret', auth.uid(), 'Tajný Kontakt', 'TK', 'tajny@klient.example'),
    ('h-team',   auth.uid(), 'Týmový Kolega', 'TK', 'kolega@firma.example');
  INSERT INTO public.project_members (project_id, member_id) VALUES ('h1', 'h-team'), ('h2', 'h-secret');
  SELECT * INTO r FROM public.create_project_invitation('h1', 'h-ed@example.test', 'member'); PERFORM set_config('t.tb', r.token, false);
  SELECT * INTO r FROM public.create_project_invitation('h1', 'h-view@example.test', 'viewer'); PERFORM set_config('t.tc', r.token, false);
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tb'), 'Editor Hana'); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.c')::uuid, 'h-view@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tc'), 'Čtenář Cyril'); END $$;

-- ================= B1 contact privacy =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test');
  PERFORM test.ok((select count(*) from public.workspace_members where id = 'h-secret') = 0, 'collaborator cannot see an owner contact that is not on a shared project');
  PERFORM test.ok((select count(*) from public.workspace_members where email = 'tajny@klient.example') = 0, 'nor find it by e-mail');
  PERFORM test.ok((select count(*) from public.workspace_members where id = 'h-team') = 1, 'collaborator sees a co-member of the shared project');
  PERFORM test.ok((select count(*) from public.workspace_members where owner_id = current_setting('t.a')::uuid) = 4, 'exactly the 4 people of the shared project (owner, team contact, editor, viewer)');
  PERFORM test.ok((select count(*) from public.workspace_members where profile_id = auth.uid()) >= 1, 'collaborator sees own member rows');
  PERFORM test.ok(NOT public.collab_can_see_member('h-secret'), 'helper agrees');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'h-view@example.test');
  PERFORM test.ok((select count(*) from public.workspace_members where id = 'h-secret') = 0, 'viewer cannot see unrelated contacts either');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'h-out@example.test');
  PERFORM test.ok((select count(*) from public.workspace_members where owner_id = current_setting('t.a')::uuid) = 0, 'outsider sees no contact of the owner');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  PERFORM test.ok((select count(*) from public.workspace_members where owner_id = auth.uid()) >= 5, 'owner still manages the whole address book');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  INSERT INTO public.cards (id, column_id, title, assignees)
  VALUES ('h1-k1', 'h1-a', 'Úkol', '[{"id":"h-team","fullName":"Týmový Kolega","email":"kolega@firma.example","profileId":"x","initials":"TK","avatarColor":"#000"}]');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test');
  PERFORM test.ok((select assignees::text not like '%@%' and assignees::text not like '%profileId%' from public.cards where id = 'h1-k1'), 'assignee JSON mirror carries no e-mail or account id');
END $$;

-- ================= B2 topic authorization + key rotation =================
DO $$
DECLARE k uuid;
BEGIN
  PERFORM test.reset();
  SELECT realtime_key INTO k FROM public.projects WHERE id = 'h1'; PERFORM set_config('t.k1', k::text, false);
  PERFORM test.act_as(current_setting('t.c')::uuid, 'h-view@example.test');
  PERFORM test.ok(public.collab_topic_allowed('project:h1:' || k::text), 'member (viewer) may use the keyed project topic');
  PERFORM test.ok(NOT public.collab_topic_allowed('project:h1'), 'the bare project topic (guessable) is not authorized');
  PERFORM test.ok(NOT public.collab_topic_allowed('project:h1:' || gen_random_uuid()::text), 'a wrong key is not authorized');
  PERFORM test.ok(public.collab_topic_allowed('user:' || auth.uid()::text), 'own notification topic');
  PERFORM test.ok(NOT public.collab_topic_allowed('user:' || current_setting('t.b')), 'not someone else''s notification topic');
  PERFORM test.ok((select realtime_key from public.projects where id = 'h1') = k, 'members can read the key (RLS on projects)');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'h-out@example.test');
  PERFORM test.ok(NOT public.collab_topic_allowed('project:h1:' || k::text), 'outsider is refused even with the right key');
  PERFORM test.ok((select count(*) from public.projects where id = 'h1') = 0, 'outsider cannot read the key');
END $$;
DO $$
DECLARE m text;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  SELECT id INTO m FROM public.workspace_members WHERE profile_id = current_setting('t.c')::uuid AND owner_id = auth.uid();
  PERFORM public.remove_project_member('h1', m);
END $$;
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.ok((select realtime_key::text from public.projects where id = 'h1') <> current_setting('t.k1'), 'removing a member rotates the project realtime key');
  PERFORM test.act_as(current_setting('t.c')::uuid, 'h-view@example.test');
  PERFORM test.ok(NOT public.collab_topic_allowed('project:h1:' || current_setting('t.k1')), 'removed member cannot (re)join the old topic');
  PERFORM test.ok((select count(*) from public.projects where id = 'h1') = 0, 'removed member cannot learn the new key');
END $$;

-- ================= C1 cross-project moves =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  INSERT INTO public.card_assignees (card_id, member_id) VALUES ('h1-k1', 'h-team');
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test'); UPDATE public.cards SET column_id = 'h2-a' WHERE id = 'h1-k1'; END $$;
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.ok((select project_id from public.cards where id = 'h1-k1') = 'h2', 'moved card belongs to the destination project');
  PERFORM test.ok((select count(*) from public.card_assignees where card_id = 'h1-k1') = 0, 'assignee who is not a member of the destination is unassigned');
  PERFORM test.ok((select assignees from public.cards where id = 'h1-k1') = '[]'::jsonb, 'and removed from the JSON mirror');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'h1' and action_type = 'card_moved_out' and entity_id = 'h1-k1') = 1, 'source project logs card_moved_out');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'h2' and action_type = 'card_moved_in' and card_id = 'h1-k1') = 1, 'destination logs card_moved_in');
  PERFORM test.ok((select count(*) from public.activity_logs where action_type = 'card_moved' and card_id = 'h1-k1') = 0, 'no in-project card_moved that would leak the other board''s column');
  PERFORM test.ok((select details::text not like '%Soukromý%' from public.activity_logs where project_id = 'h1' and action_type = 'card_moved_out'), 'source event does not name the destination project');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test');
  PERFORM test.ok((select count(*) from public.cards where id = 'h1-k1') = 0, 'source-only member can no longer read the moved card');
  PERFORM test.ok((select count(*) from public.activity_logs where action_type = 'card_moved_in') = 0, 'and sees nothing of the destination');
  UPDATE public.cards SET column_id = 'h1-a' WHERE id = 'h1-k1';
  PERFORM test.reset();
  PERFORM test.ok((select project_id from public.cards where id = 'h1-k1') = 'h2', 'source-only member cannot pull it back (invisible, 0 rows)');
END $$;

-- ================= C2 positions + column order =================
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test'); INSERT INTO public.cards (id, column_id, title, position) VALUES ('h1-p1', 'h1-b', 'x', 0); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test'); INSERT INTO public.cards (id, column_id, title, position) VALUES ('h1-p2', 'h1-b', 'y', 0); END $$;
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.ok((select position from public.cards where id = 'h1-p2') = (select position from public.cards where id = 'h1-p1') + 1, 'server assigns the next position (two clients both sending 0 do not collide)');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test');
  PERFORM public.reorder_columns('h1', ARRAY['h1-b', 'h1-a']);
  PERFORM test.ok((select string_agg(id, ',' order by position) from public.columns where project_id = 'h1') = 'h1-b,h1-a', 'atomic reorder');
  PERFORM test.throws($q$select public.reorder_columns('h1', ARRAY['h1-a'])$q$, 'PT409', 'stale column set is a conflict, not a partial reorder');
  PERFORM test.throws($q$select public.reorder_columns('h1', ARRAY['h1-a', 'h1-b', 'h2-a'])$q$, 'PT409', 'foreign column ids are refused');
  PERFORM test.ok((select string_agg(id, ',' order by position) from public.columns where project_id = 'h1') = 'h1-b,h1-a', 'order unchanged after refused reorders');
END $$;

-- ================= B4 comments =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  INSERT INTO public.cards (id, column_id, title) VALUES ('h1-k2', 'h1-a', 'Komentovaný');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  -- even the OWNER cannot backdate or impersonate through ordinary inserts (the old 5-minute rule is gone)
  INSERT INTO public.task_comments (id, card_id, author_name, content, created_at) VALUES ('hc1', 'h1-k2', 'Hana z minulosti', 'falešný', '2020-01-01');
END $$;
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.ok((select author_id = current_setting('t.a')::uuid and author_name <> 'Hana z minulosti' and created_at > now() - interval '1 hour' and origin = 'app'
                   from public.task_comments where id = 'hc1'), 'owner backdating/impersonation is ignored: real author, server time, origin app');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  PERFORM public.restore_project_board('h1', jsonb_build_object('columns', jsonb_build_array(
    jsonb_build_object('id', 'h1-a', 'name', 'A', 'cards', jsonb_build_array(jsonb_build_object('id', 'h1-k2', 'title', 'Komentovaný',
      'comments', jsonb_build_array(jsonb_build_object('id', 'hc-old', 'author_name', 'Někdo jiný', 'content', 'x', 'created_at', '2020-01-01')),
      'activities', jsonb_build_array()))),
    jsonb_build_object('id', 'h1-b', 'name', 'B', 'cards', jsonb_build_array()))));
END $$;
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.ok((select author_id is null and origin = 'import' and author_name = 'Někdo jiný' from public.task_comments where id = 'hc-old'),
    'the plain restore RPC (already deployed clients) also imports, and also marks the history as import');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  PERFORM public.restore_project_board_v2('h1', jsonb_build_object('columns', jsonb_build_array(
    jsonb_build_object('id', 'h1-a', 'name', 'A', 'cards', jsonb_build_array(jsonb_build_object('id', 'h1-k2', 'title', 'Komentovaný',
      'comments', jsonb_build_array(jsonb_build_object('id', 'hc-imp', 'author_name', 'Někdo jiný', 'content', 'x', 'created_at', '2020-01-01'),
                                    jsonb_build_object('id', 'hc-fut', 'author_name', 'Z budoucnosti', 'content', 'y', 'created_at', '2999-01-01')),
      'activities', jsonb_build_array(jsonb_build_object('id', 'ha-imp', 'text', 'Stará historie', 'created_at', '2020-01-01'))))),
    jsonb_build_object('id', 'h1-b', 'name', 'B', 'cards', jsonb_build_array()))));
END $$;
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.ok((select origin = 'import' and author_id is null and author_name = 'Někdo jiný' from public.task_comments where id = 'hc-imp'), 'restore v2 keeps history but marks it as import (unverified)');
  PERFORM test.ok((select created_at <= now() from public.task_comments where id = 'hc-fut'), 'imports are never dated in the future');
  PERFORM test.ok((select count(*) from public.task_activities where id = 'ha-imp') = 1, 'legacy task history is copied back only by the restore');
  PERFORM test.ok((select count(*) from public.task_comments where origin = 'import' and author_id is not null) = 0, 'no imported comment claims an account');
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test'); INSERT INTO public.task_comments (id, card_id, author_name, content) VALUES ('hc2', 'h1-k2', 'x', 'první verze'); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test'); UPDATE public.task_comments SET content = 'druhá verze' WHERE id = 'hc2'; END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  PERFORM test.ok((select content from public.task_comment_revisions where comment_id = 'hc2') = 'první verze', 'edit history keeps the previous text, readable by members');
  PERFORM test.ok((select edited_by from public.task_comment_revisions where comment_id = 'hc2') = current_setting('t.b')::uuid, 'and who edited');
  PERFORM test.throws($q$update public.task_comments set content = 'změna' where id = 'hc-imp'$q$, '42501', 'imported comments cannot be edited');
  PERFORM test.throws($q$insert into public.task_comment_revisions (comment_id, content) values ('hc2', 'podvrh')$q$, '42501', 'clients cannot forge edit history');
  DELETE FROM public.task_comments WHERE id = 'hc2';
END $$;
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.ok((select count(*) from public.activity_logs where card_id = 'h1-k2' and action_type in ('comment_edited', 'comment_deleted')) = 2, 'comment edit and deletion are trusted events');
  -- admin tooling (no user, e.g. the demo-data seeder) is kept but never verified
  INSERT INTO public.task_comments (id, card_id, author_name, content, created_at) VALUES ('hc-tool', 'h1-k2', 'Demo Osoba', 'seed', '2026-01-01');
  PERFORM test.ok((select origin = 'import' and author_id is null and author_name = 'Demo Osoba' from public.task_comments where id = 'hc-tool'), 'tooling insert = import, name kept');
END $$;

-- ================= C3 trusted task history =================
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test');
  PERFORM test.throws($q$insert into public.task_activities (id, card_id, text) values ('fake-h', 'h1-k2', 'Admin smazal databázi')$q$, '42501', 'clients cannot fabricate task history');
  PERFORM test.throws($q$update public.task_activities set text = 'x' where id = 'ha-imp'$q$, '42501', 'nor rewrite it');
  PERFORM test.throws($q$delete from public.task_activities where id = 'ha-imp'$q$, '42501', 'nor delete it');
  PERFORM test.ok((select count(*) from public.task_activities where id = 'ha-imp') = 1, 'legacy history stays readable');
  INSERT INTO public.task_checklists (id, card_id, text) VALUES ('hk1', 'h1-k2', 'Krok 1');
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test'); UPDATE public.task_checklists SET completed = true WHERE id = 'hk1'; END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test'); UPDATE public.task_checklists SET text = 'Krok 1 (upraveno)' WHERE id = 'hk1'; END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test'); DELETE FROM public.task_checklists WHERE id = 'hk1'; END $$;
DO $$
BEGIN
  PERFORM test.reset();
  PERFORM test.ok((select string_agg(action_type, ',' order by created_at) from public.activity_logs where card_id = 'h1-k2' and entity_type = 'checklist')
                  = 'checklist_item_added,checklist_item_completed,checklist_item_renamed,checklist_item_removed', 'checklist changes are trusted task-history events, in order');
  PERFORM test.ok((select bool_and(actor_id = current_setting('t.b')::uuid) from public.activity_logs where card_id = 'h1-k2' and entity_type = 'checklist'), 'attributed to the real actor');
END $$;

-- ================= D invitation delivery bookkeeping =================
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  SELECT * INTO r FROM public.create_project_invitation('h1', 'novy@example.test', 'member');
  PERFORM set_config('t.inv', r.id, false); PERFORM set_config('t.tok', r.token, false);
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  PERFORM test.throws($q$select * from public.create_project_invitation('h1', 'NOVY@example.test', 'viewer')$q$, 'PT429', 'second invitation to the same address within a minute is refused (duplicate send)');
  PERFORM test.ok((select status from public.invitations where id = current_setting('t.inv')) = 'pending', 'and the first invitation stays valid');
  PERFORM test.throws(format($q$select * from public.email_delivery_start(%L, %L, 'invite')$q$, repeat('x', 40), current_setting('t.inv')), '42501', 'delivery bookkeeping needs the server secret');
  PERFORM test.throws(format($q$select * from public.email_delivery_start(NULL, %L, 'invite')$q$, current_setting('t.inv')), '42501', 'no secret, no bookkeeping');
END $$;
DO $$
DECLARE s record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  SELECT * INTO s FROM public.email_delivery_start(repeat('e', 40), current_setting('t.inv'), 'invite');
  PERFORM test.ok(s.recipient = 'novy@example.test' and s.project_name = 'Sdílený' and s.project_role = 'member', 'start returns the template data (no token)');
  PERFORM public.email_delivery_finish(repeat('e', 40), s.delivery_id, 'accepted', 'smtp', '<id@local>', NULL, NULL);
  PERFORM set_config('t.del', s.delivery_id::text, false);
  PERFORM test.ok((select status from public.invitation_deliveries where id = s.delivery_id) = 'accepted', 'status recorded: accepted by the mail server (not "delivered")');
  PERFORM public.email_delivery_finish(repeat('e', 40), s.delivery_id, 'failed', 'smtp', NULL, 'x', 'late');
  PERFORM test.ok((select status from public.invitation_deliveries where id = s.delivery_id) = 'accepted', 'a finished delivery cannot be rewritten');
  PERFORM test.throws($q$update public.invitation_deliveries set status = 'accepted'$q$, '42501', 'clients cannot write delivery state');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'h-ed@example.test');
  PERFORM test.ok((select count(*) from public.invitation_deliveries) = 0, 'an editor does not see delivery state');
  PERFORM test.throws(format($q$select * from public.reissue_invitation_token(%L)$q$, current_setting('t.inv')), '42501', 'an editor cannot resend');
  PERFORM test.throws(format($q$select * from public.email_delivery_start(%L, %L, 'resend')$q$, repeat('e', 40), current_setting('t.inv')), '42501', 'even with the secret, the caller must manage the project');
  PERFORM test.act_as(current_setting('t.d')::uuid, 'h-out@example.test');
  PERFORM test.ok((select count(*) from public.invitations) = 0, 'outsider sees no invitations');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  PERFORM test.throws(format($q$select * from public.reissue_invitation_token(%L)$q$, current_setting('t.inv')), 'PT429', 'resend right after a send is throttled');
  PERFORM test.reset();
  UPDATE public.invitation_deliveries SET created_at = now() - interval '2 minutes';
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  SELECT * INTO r FROM public.reissue_invitation_token(current_setting('t.inv'));
  PERFORM set_config('t.tok2', r.token, false);
  PERFORM test.ok(r.token <> current_setting('t.tok') and char_length(r.token) = 64, 'resend issues a new 256-bit token');
  PERFORM test.ok((select state from public.invitation_preview(current_setting('t.tok'))) = 'invalid', 'the previous link stops working');
  PERFORM test.ok((select state from public.invitation_preview(r.token)) = 'valid', 'the new link works');
END $$;
DO $$
DECLARE i int;
BEGIN
  PERFORM test.reset();
  INSERT INTO public.invitation_deliveries (invitation_id, project_id, attempt_no, kind, recipient, status, created_at)
  SELECT current_setting('t.inv'), 'h1', 100 + g, 'resend', 'novy@example.test', 'accepted', now() - interval '10 minutes' FROM generate_series(1, 5) g;
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  PERFORM test.throws(format($q$select * from public.reissue_invitation_token(%L)$q$, current_setting('t.inv')), 'PT429', 'at most 5 resends per invitation and day');
END $$;
DO $$
DECLARE u uuid;
BEGIN
  u := test.mkuser('novy@example.test');
  PERFORM test.act_as(u, 'novy@example.test');
  PERFORM public.accept_workspace_invitation(current_setting('t.tok2'), 'Nový');
  PERFORM test.ok(public.project_role('h1') = 'member', 'the re-issued link grants the invited role');
  PERFORM test.throws(format($q$select public.accept_workspace_invitation(%L, 'x')$q$, current_setting('t.tok2')), NULL, 'and is single use');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'h-own@example.test');
  PERFORM test.throws(format($q$select * from public.reissue_invitation_token(%L)$q$, current_setting('t.inv')), '22023', 'an accepted invitation cannot be re-sent');
  PERFORM test.throws(format($q$select * from public.email_delivery_start(%L, %L, 'resend')$q$, repeat('e', 40), current_setting('t.inv')), '22023', 'nor e-mailed again');
END $$;

-- ================= tooling vs. integrations =================
DO $$
BEGIN
  PERFORM test.reset();
  INSERT INTO public.projects (id, name, user_id) VALUES ('h-tool', 'Import', current_setting('t.a')::uuid);
  INSERT INTO public.project_members (project_id, member_id) VALUES ('h-tool', 'h-team');
END $$;
DO $$
BEGIN
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'h-tool') = 0, 'anonymous tooling (demo-data import) writes no "Systém" events next to imported history');
  PERFORM set_config('clearspace.event_source', 'gmail', true);
  UPDATE public.projects SET name = 'Import (Gmail)' WHERE id = 'h-tool';
  PERFORM test.ok((select source from public.activity_logs where project_id = 'h-tool' and action_type = 'project_renamed') = 'gmail', 'an integration that declares its source does get trusted events');
  PERFORM test.ok((select actor_name from public.activity_logs where project_id = 'h-tool' and action_type = 'project_renamed') = 'Systém', 'attributed to the system, not to a person');
END $$;
