-- Cross-user / cross-workspace isolation, profiles, forced membership, anon.
DO $$
DECLARE
  a uuid := test.mkuser('a@example.test');
  b uuid := test.mkuser('b@example.test');
  c uuid := test.mkuser('c@example.test');
  n int;
BEGIN
  -- signup trigger still works (hardened SECURITY DEFINER keeps functioning)
  PERFORM test.ok((select count(*) from public.profiles where id in (a,b,c)) = 3, 'signup trigger created 3 profiles');
  PERFORM test.ok((select count(*) from public.workspace_members where profile_id in (a,b,c) and workspace_role='owner') = 3, 'signup trigger created owner members');

  -- A builds a project
  PERFORM test.act_as(a, 'a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pA', 'Project A');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('pA-col', 'pA', 'Todo', 0);
  INSERT INTO public.cards (id, column_id, title) VALUES ('pA-card', 'pA-col', 'Secret card');
  PERFORM test.ok((select count(*) from public.cards) = 1, 'A sees own card');

  -- B builds own project
  PERFORM test.act_as(b, 'b@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pB', 'Project B');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('pB-col', 'pB', 'Todo', 0);
  INSERT INTO public.cards (id, column_id, title) VALUES ('pB-card', 'pB-col', 'B card');

  -- Isolation (reads)
  PERFORM test.ok((select count(*) from public.projects where id = 'pA') = 0, 'B cannot read A project');
  PERFORM test.ok((select count(*) from public.columns where id = 'pA-col') = 0, 'B cannot read A column');
  PERFORM test.ok((select count(*) from public.cards where id = 'pA-card') = 0, 'B cannot read A card');
  -- Isolation (writes)
  PERFORM test.throws($q$insert into public.cards (id, column_id, title) values ('evil', 'pA-col', 'x')$q$, '42501', 'B cannot insert a card into A column');
  PERFORM test.throws($q$insert into public.columns (id, project_id, name) values ('evil-col', 'pA', 'x')$q$, '42501', 'B cannot insert a column into A project');
  PERFORM test.throws($q$update public.cards set column_id = 'pA-col' where id = 'pB-card'$q$, '42501', 'B cannot move own card INTO A column');
  PERFORM test.throws($q$insert into public.projects (id, name, user_id) values ('spoof', 'x', '00000000-0000-0000-0000-000000000001')$q$, '42501', 'B cannot create a project owned by someone else');
  UPDATE public.cards SET title = 'hacked' WHERE id = 'pA-card';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'B update of A card affects 0 rows');
  DELETE FROM public.projects WHERE id = 'pA';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'B delete of A project affects 0 rows');

  -- profiles: own row only
  PERFORM test.ok((select count(*) from public.profiles) = 1, 'B sees only own profile');
  PERFORM test.ok((select id from public.profiles) = b, 'the visible profile is B');
  -- workspace members: B cannot see A contacts
  PERFORM test.ok((select count(*) from public.workspace_members where owner_id = a) = 0, 'B cannot read A workspace members');

  -- anon: nothing at all
  PERFORM test.act_as_anon();
  PERFORM test.throws('select * from public.profiles', '42501', 'anon cannot read profiles');
  PERFORM test.throws('select * from public.projects', '42501', 'anon cannot read projects');
  PERFORM test.throws('select * from public.cards', '42501', 'anon cannot read cards');
  PERFORM test.throws('select * from public.invitations', '42501', 'anon cannot read invitations');
  PERFORM test.throws('select * from public.ai_requests', '42501', 'anon cannot read ai_requests');
  PERFORM test.throws('select * from public.workspace_members', '42501', 'anon cannot read workspace_members');

  -- Forced membership guards
  PERFORM test.act_as(a, 'a@example.test');
  PERFORM test.throws(format($q$insert into public.workspace_members (id, owner_id, profile_id, full_name, initials, email) values ('m-force', %L, %L, 'Victim', 'V', 'b@example.test')$q$, a, b),
    '42501', 'A cannot link ANOTHER account (B) to a member row');
  PERFORM test.throws(format($q$update public.workspace_members set profile_id = %L where owner_id = %L and profile_id = %L$q$, b, a, a),
    '42501', 'A cannot re-point own member row to B');
  INSERT INTO public.workspace_members (id, owner_id, full_name, initials, email) VALUES ('m-placeholder', a, 'Placeholder', 'PH', 'ph@example.test');
  PERFORM test.ok(true, 'A can create an unlinked placeholder member');
  INSERT INTO public.project_members (project_id, member_id) VALUES ('pA', 'm-placeholder');
  PERFORM test.ok(true, 'A can put own placeholder on own project');
  PERFORM test.throws(format($q$insert into public.project_members (project_id, member_id) values ('pA', %L)$q$, 'member-owner-' || c),
    '42501', 'A cannot add a member row of C workspace to own project (forced membership)');
  PERFORM test.throws($q$update public.project_members set member_id = 'member-owner-00000000-0000-0000-0000-000000000000' where project_id='pA'$q$, NULL, 'A cannot re-point a project member to a foreign row');

  -- activity log spoofing
  PERFORM test.throws(format($q$insert into public.activity_logs (id, project_id, actor_id, actor_name, action_type, entity_type) values ('act-spoof','pA',%L,'B','x','task')$q$, b),
    '42501', 'A cannot log activity as B');
  INSERT INTO public.activity_logs (id, project_id, actor_id, actor_name, action_type, entity_type) VALUES ('act-ok','pA',a,'A','x','task');
  INSERT INTO public.activity_logs (id, project_id, actor_name, action_type, entity_type) VALUES ('act-null','pA','A','x','task');
  PERFORM test.ok(true, 'A can log activity as self or NULL');
  UPDATE public.activity_logs SET actor_name = 'x' WHERE id = 'act-ok';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'activity logs are immutable for clients (0 rows updated)');
EXCEPTION WHEN OTHERS THEN
  PERFORM test.reset();
  RAISE;
END $$;
