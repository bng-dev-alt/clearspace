-- Collaboration (20261124001000). Runs in AUTOCOMMIT mode on its own database (see collab.sh):
-- every DO block is one committed transaction, exactly like one PostgREST request, so the deferred
-- event triggers fire as in production. Ids travel between blocks as session settings (t.*).
\set ON_ERROR_STOP 1

DO $$
DECLARE a uuid; b uuid; c uuid; d uuid; e uuid;
BEGIN
  a := test.mkuser('own@example.test');  b := test.mkuser('ed@example.test');
  c := test.mkuser('view@example.test'); d := test.mkuser('out@example.test');
  e := test.mkuser('late@example.test');
  PERFORM set_config('t.a', a::text, false); PERFORM set_config('t.b', b::text, false);
  PERFORM set_config('t.c', c::text, false); PERFORM set_config('t.d', d::text, false);
  PERFORM set_config('t.e', e::text, false);
END $$;

-- A creates a project; the whole board in ONE transaction (= seed) produces project_created only
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pX', 'Projekt X');
  INSERT INTO public.columns (id, project_id, name, position) VALUES
    ('pX-todo', 'pX', 'K řešení', 0), ('pX-doing', 'pX', 'V průběhu', 1), ('pX-done', 'pX', 'Hotovo', 2);
  INSERT INTO public.project_members (project_id, member_id) VALUES ('pX', 'member-owner-' || current_setting('t.a'));
END $$;
DO $$
BEGIN
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX' and action_type = 'project_created') = 1, 'project_created logged once');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX' and action_type = 'column_created') = 0, 'initial board seed is not logged column by column');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX' and action_type = 'member_added') = 0, 'owner''s own membership row is not news');
  PERFORM test.ok((select workspace_id from public.activity_logs where project_id = 'pX' limit 1) = current_setting('t.a')::uuid, 'event carries the workspace (owner) id');
END $$;

-- Invitations: B as editor, C as viewer (token flow), E later in-app
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  SELECT * INTO r FROM public.create_project_invitation('pX', 'ED@example.test', 'member');
  PERFORM set_config('t.tok_b', r.token, false);
  SELECT * INTO r FROM public.create_project_invitation('pX', 'view@example.test', 'viewer');
  PERFORM set_config('t.tok_c', r.token, false);
  PERFORM test.ok(char_length(r.token) = 64, 'project invitation returns a 256-bit token once');
  PERFORM test.throws('select token_hash from public.invitations', '42501', 'clients cannot read token hashes');
  PERFORM test.reset();
  PERFORM test.ok((select token_hash from public.invitations where id = r.id) = encode(extensions.digest(r.token, 'sha256'), 'hex'), 'only the hash is stored');
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  PERFORM test.throws($q$select * from public.create_project_invitation('pX', 'x@example.test', 'owner')$q$, '22023', 'role owner cannot be granted by invitation');
  PERFORM test.throws($q$select * from public.create_project_invitation('pX', 'own@example.test', 'member')$q$, '22023', 'owner cannot invite themself');
END $$;
DO $$
BEGIN
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX' and action_type = 'member_invited') = 2, 'invitations are logged');
  PERFORM test.ok((select bool_and(details->>'email' LIKE '_***@example.test') from public.activity_logs where project_id = 'pX' and action_type = 'member_invited'), 'logged e-mail is masked');
  -- existing verified accounts get an in-app invitation
  PERFORM test.ok((select count(*) from public.notifications where recipient_id = current_setting('t.b')::uuid and type = 'invitation') = 1, 'invited existing account gets an in-app invitation');
END $$;

-- D (outsider) cannot use B's token; B accepts
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.d')::uuid, 'out@example.test');
  PERFORM test.throws(format('select public.accept_workspace_invitation(%L, %L)', current_setting('t.tok_b'), 'Evil'), NULL, 'a different account cannot accept the invitation', 'jiný e-mail');
  PERFORM test.throws(format('select public.accept_invitation_by_id(%L)', (select id from public.invitations where email = 'ed@example.test' and status = 'pending')), NULL, 'nor accept it by id');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test');
  PERFORM public.accept_workspace_invitation(current_setting('t.tok_b'), 'Editor Bob');
  PERFORM test.ok(public.project_role('pX') = 'member', 'accepted project invitation grants the invited role (editor)');
  PERFORM test.throws(format('select public.accept_workspace_invitation(%L, %L)', current_setting('t.tok_b'), 'x'), NULL, 'a used token is refused', 'použita');
  PERFORM test.ok((select count(*) from public.notifications where recipient_id = current_setting('t.b')::uuid and type = 'invitation') = 0, 'accepted invitation notification is cleared');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'view@example.test');
  PERFORM public.accept_workspace_invitation(current_setting('t.tok_c'), 'Viewer Cyril');
  PERFORM test.ok(public.project_role('pX') = 'viewer', 'viewer role granted');
  PERFORM test.ok((select count(*) from public.projects where id = 'pX') = 1, 'viewer can read the project');
END $$;
DO $$
BEGIN
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX' and action_type = 'member_added') = 2, 'both joins are logged');
  PERFORM test.ok((select count(*) from public.notifications where recipient_id = current_setting('t.a')::uuid and type = 'invitation_accepted') = 2, 'inviter is told about acceptances');
  PERFORM test.ok((select member_ids from public.projects where id = 'pX') @> to_jsonb(ARRAY[(select id from public.workspace_members where profile_id = current_setting('t.b')::uuid and owner_id = current_setting('t.a')::uuid)]), 'member_ids mirror kept in sync');
END $$;

-- Expired invitation
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  SELECT * INTO r FROM public.create_project_invitation('pX', 'out@example.test', 'member');
  PERFORM set_config('t.tok_d', r.token, false);
  PERFORM test.reset();
  UPDATE public.invitations SET expires_at = now() - interval '1 minute' WHERE id = r.id;
  PERFORM test.act_as(current_setting('t.d')::uuid, 'out@example.test');
  PERFORM test.throws(format('select public.accept_workspace_invitation(%L, %L)', r.token, 'D'), NULL, 'expired invitation is refused', 'vypršela');
  PERFORM test.throws(format('select public.accept_invitation_by_id(%L)', r.id), NULL, 'expired invitation is refused in-app too', 'vypršela');
  PERFORM test.ok(public.project_role('pX') IS NULL, 'expired invitation granted nothing');
END $$;

-- Editor B works on the board
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test');
  INSERT INTO public.cards (id, column_id, title, project_id, version) VALUES ('k1', 'pX-todo', 'Navrhnout logo', 'spoofed', 99);
END $$;
DO $$
BEGIN
  PERFORM test.ok((select project_id from public.cards where id = 'k1') = 'pX', 'card project_id is server-derived (spoof ignored)');
  PERFORM test.ok((select version from public.cards where id = 'k1') = 1, 'version starts at 1 (client value ignored)');
  PERFORM test.ok((select count(*) from public.activity_logs where card_id = 'k1' and action_type = 'card_created' and actor_id = current_setting('t.b')::uuid and actor_name = 'Editor Bob') = 1, 'card_created by the real actor with the workspace display name');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test');
  UPDATE public.cards SET column_id = 'pX-done', priority = 'High', due_date = '2026-12-01' WHERE id = 'k1';
END $$;
DO $$
BEGIN
  PERFORM test.ok((select details->>'completed' from public.activity_logs where card_id = 'k1' and action_type = 'card_moved') = 'true', 'move into Hotovo is a completion');
  PERFORM test.ok((select details->>'from' from public.activity_logs where card_id = 'k1' and action_type = 'card_moved') = 'K řešení', 'move keeps from/to column names (dashboard burndown contract)');
  PERFORM test.ok((select count(*) from public.activity_logs where card_id = 'k1' and action_type in ('card_priority_changed', 'card_due_changed')) = 2, 'priority + deadline changes logged');
  PERFORM test.ok((select version from public.cards where id = 'k1') = 2, 'one update = one version step');
END $$;

-- description edits are coalesced; content is not stored
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test'); UPDATE public.cards SET details = 'tajný obsah 1' WHERE id = 'k1'; END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test'); UPDATE public.cards SET details = 'tajný obsah 2' WHERE id = 'k1'; END $$;
DO $$
BEGIN
  PERFORM test.ok((select count(*) from public.activity_logs where card_id = 'k1' and action_type = 'card_details_changed') = 1, 'description edits coalesced per actor/card');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX' and details::text like '%tajný%') = 0, 'description content is never copied into the log');
END $$;

-- Assignment -> notification to the assignee only
DO $$
DECLARE mb text;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  SELECT id INTO mb FROM public.workspace_members WHERE profile_id = current_setting('t.b')::uuid AND owner_id = current_setting('t.a')::uuid;
  PERFORM set_config('t.mb', mb, false);
  INSERT INTO public.card_assignees (card_id, member_id, position) VALUES ('k1', mb, 0);
END $$;
DO $$
BEGIN
  PERFORM test.ok((select count(*) from public.activity_logs where card_id = 'k1' and action_type = 'card_assigned') = 1, 'assignment logged');
  PERFORM test.ok((select count(*) from public.notifications where recipient_id = current_setting('t.b')::uuid and type = 'assignment' and card_id = 'k1') = 1, 'assignee notified');
  PERFORM test.ok((select count(*) from public.notifications where type = 'assignment' and recipient_id <> current_setting('t.b')::uuid) = 0, 'nobody else notified');
  PERFORM test.ok((select child_rev from public.cards where id = 'k1') >= 1 and (select version from public.cards where id = 'k1') = 4, 'child change bumps child_rev, not version');
END $$;
-- delete + re-insert of the same assignee in one transaction is no change
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  DELETE FROM public.card_assignees WHERE card_id = 'k1';
  INSERT INTO public.card_assignees (card_id, member_id, position) VALUES ('k1', current_setting('t.mb'), 0);
END $$;
DO $$
BEGIN
  PERFORM test.ok((select count(*) from public.activity_logs where card_id = 'k1' and action_type in ('card_assigned', 'card_unassigned')) = 1, 'resync of identical assignees writes no events');
END $$;

-- Comments: verified author, mentions filtered to members, notifications
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test');
  INSERT INTO public.task_comments (id, card_id, author_name, content, mentions, author_id, created_at)
  VALUES ('cm1', 'k1', 'Majitel A', 'Ahoj @Cyril a @Outsider', ARRAY[current_setting('t.c')::uuid, current_setting('t.d')::uuid, current_setting('t.b')::uuid],
          current_setting('t.a')::uuid, '2020-01-01');
END $$;
DO $$
BEGIN
  PERFORM test.ok((select author_id from public.task_comments where id = 'cm1') = current_setting('t.b')::uuid, 'comment author_id is the caller (spoof ignored)');
  PERFORM test.ok((select author_name from public.task_comments where id = 'cm1') = 'Editor Bob', 'comment author_name is server-derived');
  PERFORM test.ok((select created_at from public.task_comments where id = 'cm1') > now() - interval '1 hour', 'comment time is server time');
  PERFORM test.ok((select mentions from public.task_comments where id = 'cm1') = ARRAY[current_setting('t.c')::uuid], 'mentions keep only project members, never the author');
  PERFORM test.ok((select count(*) from public.notifications where recipient_id = current_setting('t.c')::uuid and type = 'mention' and entity_id = 'cm1') = 1, 'mentioned member notified');
  PERFORM test.ok((select count(*) from public.notifications where recipient_id = current_setting('t.d')::uuid and type = 'mention') = 0, 'non-member mention produces NO notification (no leak)');
  PERFORM test.ok((select count(*) from public.activity_logs where action_type = 'comment_added' and entity_id = 'cm1') = 1, 'comment logged');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX' and details::text like '%Outsider%') = 0, 'comment text is not copied into the log');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  INSERT INTO public.task_comments (id, card_id, author_name, content) VALUES ('cm2', 'k1', 'x', 'Od vlastníka');
END $$;
DO $$
BEGIN
  PERFORM test.ok((select count(*) from public.notifications where recipient_id = current_setting('t.b')::uuid and type = 'comment' and entity_id = 'cm2') = 1, 'assignee hears about a new comment on their task');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test');
  PERFORM test.throws($q$update public.task_comments set content = 'přepsáno' where id = 'cm2'$q$, '42501', 'cannot edit somebody else''s comment');
  PERFORM test.throws($q$delete from public.task_comments where id = 'cm2'$q$, '42501', 'editor cannot delete somebody else''s comment');
  PERFORM test.throws($q$insert into public.task_comments (id, card_id, author_name, content) values ('cm-empty', 'k1', 'x', '   ')$q$, '22023', 'empty comment refused');
  PERFORM test.throws(format($q$insert into public.task_comments (id, card_id, author_name, content) values ('cm-long', 'k1', 'x', %L)$q$, repeat('x', 5001)), '22023', 'over-long comment refused');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test');
  UPDATE public.task_comments SET content = 'Ahoj @Cyril (upraveno)', author_name = 'Hacker' WHERE id = 'cm1';
END $$;
DO $$
BEGIN
  PERFORM test.ok((select updated_at is not null and author_name = 'Editor Bob' from public.task_comments where id = 'cm1'), 'own edit is stamped, identity fields immutable');
  PERFORM test.ok((select count(*) from public.notifications where recipient_id = current_setting('t.c')::uuid and type = 'mention') = 1, 'editing a comment does not re-notify existing mentions');
END $$;

-- Viewer C: read yes, write no (direct and through every content table)
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'view@example.test');
  PERFORM test.ok((select count(*) from public.cards where id = 'k1') = 1, 'viewer reads cards');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX') > 0, 'viewer reads the activity timeline');
  PERFORM test.throws($q$insert into public.cards (id, column_id, title) values ('kv', 'pX-todo', 'x')$q$, '42501', 'viewer cannot create a card');
  PERFORM test.throws($q$update public.cards set title = 'x' where id = 'k1'$q$, '42501', 'viewer cannot edit a card');
  PERFORM test.throws($q$update public.cards set column_id = 'pX-todo' where id = 'k1'$q$, '42501', 'viewer cannot move a card');
  PERFORM test.throws($q$delete from public.cards where id = 'k1'$q$, '42501', 'viewer cannot delete a card');
  PERFORM test.throws($q$insert into public.columns (id, project_id, name, position) values ('cv', 'pX', 'x', 9)$q$, '42501', 'viewer cannot add a column');
  PERFORM test.throws($q$update public.columns set name = 'x' where id = 'pX-todo'$q$, '42501', 'viewer cannot rename a column');
  PERFORM test.throws($q$insert into public.task_comments (id, card_id, author_name, content) values ('cv1', 'k1', 'x', 'y')$q$, '42501', 'viewer cannot comment');
  PERFORM test.throws($q$insert into public.task_checklists (id, card_id, text) values ('chv', 'k1', 'x')$q$, '42501', 'viewer cannot add checklist items');
  PERFORM test.throws(format($q$insert into public.card_assignees (card_id, member_id) values ('k1', %L)$q$, current_setting('t.mb')), '42501', 'viewer cannot assign');
  PERFORM test.throws($q$insert into public.meetings (project_id, title, source_kind, created_by) values ('pX', 'x', 'text', auth.uid())$q$, '42501', 'viewer cannot create meetings');
  PERFORM test.throws($q$select * from public.create_project_invitation('pX', 'q@example.test', 'viewer')$q$, '42501', 'viewer cannot invite');
  PERFORM test.throws($q$insert into public.activity_logs (id, project_id, actor_name, action_type, entity_type) values ('fake', 'pX', 'x', 'card_created', 'task')$q$, '42501', 'nobody can write events directly');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test');
  PERFORM test.throws($q$insert into public.activity_logs (id, project_id, actor_name, action_type, entity_type) values ('fake2', 'pX', 'x', 'member_removed', 'member')$q$, '42501', 'editor cannot fabricate events either');
  PERFORM test.throws($q$insert into public.activity_logs (id, project_id, actor_name, action_type, entity_type) values ('fake3', 'pX', 'x', 'card_created', 'task')$q$, '42501', 'self-attested event needs a real card of the project');
  INSERT INTO public.activity_logs (id, project_id, card_id, actor_id, actor_name, action_type, entity_type, created_at)
  VALUES ('selfrep', 'pX', 'k1', current_setting('t.a')::uuid, 'Majitel', 'card_created', 'task', '2001-01-01');
  PERFORM test.ok((select actor_id = auth.uid() and actor_name = 'Editor Bob' and source = 'client' and created_at > now() - interval '1 hour' from public.activity_logs where id = 'selfrep'),
    'the narrow self-attested path (Intelligence RPCs) forces actor, name, time and marks source=client');
  PERFORM test.throws($q$update public.activity_logs set actor_name = 'x' where id = 'selfrep'$q$, '42501', 'events are immutable');
  PERFORM test.throws($q$delete from public.activity_logs where id = 'selfrep'$q$, '42501', 'events cannot be deleted by clients');
END $$;

-- Outsider D: nothing
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.d')::uuid, 'out@example.test');
  PERFORM test.ok((select count(*) from public.projects where id = 'pX') = 0, 'outsider cannot read the project');
  PERFORM test.ok((select count(*) from public.cards where project_id = 'pX') = 0, 'outsider cannot read cards');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX') = 0, 'outsider cannot read the timeline');
  PERFORM test.ok((select count(*) from public.task_comments where card_id = 'k1') = 0, 'outsider cannot read comments');
  PERFORM test.ok((select count(*) from public.notifications where recipient_id <> auth.uid()) = 0, 'outsider sees no notifications of others');
  PERFORM test.ok(public.project_role('pX') IS NULL, 'outsider has no role');
  PERFORM test.throws(format($q$select public.set_project_member('pX', %L, 'admin')$q$, current_setting('t.mb')), '42501', 'outsider cannot manage members');
  PERFORM test.throws($q$select public.remove_project_member('pX', 'member-owner-' || current_setting('t.a'))$q$, '42501', 'outsider cannot remove the owner');
END $$;

-- Notifications are private and only read_at is writable
DO $$
DECLARE n int;
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test');
  PERFORM test.ok((select count(*) from public.notifications where recipient_id <> auth.uid()) = 0, 'B reads only own notifications');
  UPDATE public.notifications SET read_at = now() WHERE recipient_id = current_setting('t.c')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'B cannot mark C''s notifications');
  PERFORM test.throws($q$update public.notifications set title = 'x'$q$, '42501', 'only read_at is writable');
  PERFORM test.throws(format($q$insert into public.notifications (recipient_id, type, actor_name, title) values (%L, 'mention', 'x', 'y')$q$, current_setting('t.c')), '42501', 'clients cannot create notifications');
  UPDATE public.notifications SET read_at = now() WHERE read_at IS NULL;
  PERFORM test.ok((select count(*) from public.notifications where read_at is null) = 0, 'mark all read');
END $$;

-- Role management: owner promotes B to admin; admin limits
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  PERFORM public.set_project_member('pX', current_setting('t.mb'), 'admin');
  PERFORM test.throws($q$select public.set_project_member('pX', 'member-owner-' || current_setting('t.a'), 'viewer')$q$, '42501', 'owner row cannot be demoted');
  PERFORM test.throws($q$select public.set_project_member('pX', 'nonexistent', 'viewer')$q$, '42501', 'unknown member refused');
END $$;
DO $$
DECLARE mc text;
BEGIN
  PERFORM test.ok((select count(*) from public.notifications where recipient_id = current_setting('t.b')::uuid and type = 'project_role_changed') = 1, 'role change notifies the member');
  PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test');
  SELECT id INTO mc FROM public.workspace_members WHERE profile_id = current_setting('t.c')::uuid AND owner_id = current_setting('t.a')::uuid;
  PERFORM set_config('t.mc', mc, false);
  PERFORM test.ok(public.project_role('pX') = 'admin', 'B is admin');
  PERFORM test.throws(format($q$select public.set_project_member('pX', %L, 'admin')$q$, mc), '42501', 'admin cannot grant admin');
  PERFORM test.throws(format($q$select public.set_project_member('pX', %L, 'viewer')$q$, current_setting('t.mb')), '42501', 'admin cannot change own role');
  PERFORM test.throws($q$select * from public.create_project_invitation('pX', 'boss@example.test', 'admin')$q$, '42501', 'admin cannot invite an admin');
  PERFORM test.throws($q$insert into public.project_members (project_id, member_id, project_role) values ('pX', 'x', 'admin')$q$, '42501', 'admin cannot write project_members directly (owner-only RLS)');
  PERFORM public.set_project_member('pX', mc, 'member');
  PERFORM test.ok((select project_role from public.project_members where member_id = mc and project_id = 'pX') = 'member', 'admin can promote viewer to editor');
  PERFORM public.set_project_member('pX', mc, 'viewer');
END $$;

-- Optimistic concurrency contract (what the client does): conditional update on version
DO $$
DECLARE n int; v bigint;
BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test');
  SELECT version INTO v FROM public.cards WHERE id = 'k1';
  UPDATE public.cards SET title = 'Varianta B' WHERE id = 'k1' AND version = v;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 1, 'update with the current version succeeds');
  UPDATE public.cards SET title = 'Varianta stale' WHERE id = 'k1' AND version = v;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'update with a stale version changes nothing (conflict detected)');
  PERFORM test.ok((select title from public.cards where id = 'k1') = 'Varianta B', 'first writer kept');
END $$;

-- Removal: C loses access, project notifications purged, removal notified
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  PERFORM public.remove_project_member('pX', current_setting('t.mc'));
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.c')::uuid, 'view@example.test');
  PERFORM test.ok(public.project_role('pX') IS NULL, 'removed member has no role');
  PERFORM test.ok((select count(*) from public.cards where project_id = 'pX') = 0, 'removed member cannot read cards');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX') = 0, 'removed member cannot read the timeline');
  PERFORM test.ok((select count(*) from public.notifications where type <> 'project_removed') = 0, 'removed member''s old project notifications are purged');
  PERFORM test.ok((select count(*) from public.notifications where type = 'project_removed') = 1, 'removed member is told');
  PERFORM test.ok(NOT public.is_project_member('pX'), 'realtime/presence authorization (is_project_member) is false');
END $$;

-- In-app acceptance by id for an existing verified account
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  SELECT * INTO r FROM public.create_project_invitation('pX', 'late@example.test', 'viewer');
  PERFORM set_config('t.inv_e', r.id, false);
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.e')::uuid, 'late@example.test');
  PERFORM test.ok((select count(*) from public.notifications where type = 'invitation' and entity_id = current_setting('t.inv_e')) = 1, 'in-app invitation visible to the invitee');
  PERFORM test.ok((select title from public.notifications where type = 'invitation') = 'Projekt X', 'invitation names the project');
  PERFORM test.ok(public.accept_invitation_by_id(current_setting('t.inv_e')) = 'pX', 'in-app acceptance returns the project');
  PERFORM test.ok(public.project_role('pX') = 'viewer', 'in-app acceptance grants the invited role');
END $$;
DO $$
DECLARE r record;
BEGIN
  -- revocation
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  SELECT * INTO r FROM public.create_project_invitation('pX', 'revoked@example.test', 'member');
  PERFORM public.revoke_invitation(r.id);
  PERFORM test.ok((select status from public.invitations where id = r.id) = 'rejected', 'revoked invitation');
  PERFORM test.ok((select state from public.invitation_preview(r.token)) = 'used', 'revoked token is no longer valid');
END $$;
DO $$
DECLARE i int;
BEGIN
  -- per-inviter rate limit (20 / hour)
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  PERFORM test.throws($q$DO $x$ BEGIN FOR i IN 1..25 LOOP PERFORM public.create_project_invitation('pX', 'bulk' || i || '@example.test', 'viewer'); END LOOP; END $x$ $q$,
    'PT429', 'invitation rate limit');
END $$;

-- Owner deletes another's comment; restore keeps history quiet
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  DELETE FROM public.task_comments WHERE id = 'cm1';
  PERFORM test.ok((select count(*) from public.task_comments where id = 'cm1') = 0, 'owner may delete any comment');
END $$;
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test');
  PERFORM public.restore_project_board_v2('pX', '{"columns":[{"id":"pX-todo","name":"K řešení","cards":[{"id":"k1","title":"Obnoveno","comments":[{"id":"cmr","author_name":"Bob z minulosti","content":"staré","created_at":"2026-01-01T00:00:00Z"}]}]},{"id":"pX-done","name":"Hotovo","cards":[]}]}'::jsonb);
END $$;
DO $$
BEGIN
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX' and action_type = 'board_restored') = 1, 'restore = ONE board_restored event');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX' and action_type in ('card_created', 'card_deleted', 'column_deleted', 'column_created') and created_at = (select created_at from public.activity_logs where project_id = 'pX' and action_type = 'board_restored')) = 0, 'no per-row noise from the restore');
  PERFORM test.ok((select author_name = 'Bob z minulosti' and author_id is null and origin = 'import' from public.task_comments where id = 'cmr'), 'restored comment keeps its recorded name, marked as import (unverified)');
END $$;

-- A normal column add/delete later IS logged
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test'); INSERT INTO public.columns (id, project_id, name, position) VALUES ('pX-rev', 'pX', 'Revize', 5); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'ed@example.test'); DELETE FROM public.columns WHERE id = 'pX-rev'; END $$;
DO $$
BEGIN
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX' and action_type = 'column_created' and entity_id = 'pX-rev') = 1, 'column added later is logged');
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX' and action_type = 'column_deleted' and entity_id = 'pX-rev') = 1, 'column deletion is logged');
END $$;

-- Storage: viewer cannot upload task files
DO $$
BEGIN
  PERFORM test.act_as(current_setting('t.e')::uuid, 'late@example.test');
  PERFORM test.throws($q$insert into storage.objects (bucket_id, name, owner) values ('task-resources', 'tasks/k1/x.pdf', auth.uid())$q$, '42501', 'viewer cannot upload task files');
END $$;

-- Project deletion cascades cleanly (no events for a vanished project)
DO $$ BEGIN PERFORM test.act_as(current_setting('t.a')::uuid, 'own@example.test'); DELETE FROM public.projects WHERE id = 'pX'; END $$;
DO $$
BEGIN
  PERFORM test.ok((select count(*) from public.activity_logs where project_id = 'pX') = 0, 'project deletion removes its events');
  PERFORM test.ok((select count(*) from public.notifications where project_id = 'pX') = 0, 'and its notifications');
END $$;
