-- AI History restore: atomic, project-scoped, owner-only.
DO $$
DECLARE
  a uuid := test.mkuser('rs-a@example.test');
  b uuid := test.mkuser('rs-b@example.test');
  r jsonb;
  n int;
  payload jsonb;
  bad jsonb;
BEGIN
  PERFORM test.act_as(a, 'rs-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('rs1', 'P1'), ('rs2', 'P2');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('rs1-c1','rs1','Todo',0), ('rs2-c1','rs2','Todo',0);
  INSERT INTO public.cards (id, column_id, title) VALUES ('rs1-k-current','rs1-c1','CURRENT (after AI change)'), ('rs2-k1','rs2-c1','P2 card 1'), ('rs2-k2','rs2-c1','P2 card 2');

  payload := '{"columns":[{"id":"rs1-old-c1","name":"Old Todo","cards":[
     {"id":"rs1-old-k1","title":"Restored 1","priority":"High","archived":false,
      "checklist":[{"id":"cl1","text":"step","completed":true}],
      "comments":[{"id":"cm1","author_name":"A","content":"hi","created_at":"2026-01-01T00:00:00Z"}],
      "activities":[{"id":"ac1","text":"did","created_at":"2026-01-01T00:00:00Z"}],
      "assignee_ids":["member-owner-' || a || '","member-that-no-longer-exists"]},
     {"id":"rs1-old-k2","title":"Restored 2"}]},
   {"id":"rs1-old-c2","name":"Old Done","cards":[]}]}';

  -- success: only P1 changes, everything else untouched
  r := public.restore_project_board('rs1', payload);
  PERFORM test.ok((r->>'cards')::int = 2 AND (r->>'columns')::int = 2, 'restore reports restored columns/cards');
  PERFORM test.ok((select count(*) from public.cards where column_id like 'rs1-%') = 2, 'P1 board replaced by the snapshot');
  PERFORM test.ok((select count(*) from public.cards where id = 'rs1-k-current') = 0, 'later (post-snapshot) card of P1 is gone (scoped replace)');
  PERFORM test.ok((select count(*) from public.cards where column_id = 'rs2-c1') = 2, 'P2 is completely untouched');
  PERFORM test.ok((select count(*) from public.projects where id in ('rs1','rs2')) = 2, 'no project was deleted');
  PERFORM test.ok((select count(*) from public.task_checklists where card_id='rs1-old-k1') = 1, 'checklist restored');
  PERFORM test.ok((select count(*) from public.task_comments where card_id='rs1-old-k1') = 1, 'comment restored');
  PERFORM test.ok((select count(*) from public.task_activities where card_id='rs1-old-k1') = 1, 'activity restored');
  PERFORM test.ok((select count(*) from public.card_assignees where card_id='rs1-old-k1') = 1, 'existing assignee re-linked, vanished member skipped');
  PERFORM test.ok((select position from public.columns where id='rs1-old-c2') = 1, 'column order preserved');

  -- atomicity: a payload that fails half-way (duplicate card id) must leave the board as it was
  bad := '{"columns":[{"id":"rs1-bad-c1","name":"X","cards":[{"id":"dup","title":"a"},{"id":"dup","title":"b"}]}]}';
  PERFORM test.throws(format($q$select public.restore_project_board('rs1', %L::jsonb)$q$, bad::text), '23505', 'failing restore raises');
  PERFORM test.ok((select count(*) from public.cards where column_id like 'rs1-old-%') = 2, 'ATOMIC: after a failed restore the previous board is intact');
  PERFORM test.ok((select count(*) from public.columns where project_id = 'rs1') = 2, 'ATOMIC: columns intact after failure');

  -- validation
  PERFORM test.throws($q$select public.restore_project_board('rs1', '{"columns":"nope"}'::jsonb)$q$, '22023', 'malformed snapshot rejected');
  PERFORM test.throws($q$select public.restore_project_board('rs1', NULL)$q$, '22023', 'null snapshot rejected');
  PERFORM test.throws($q$select public.restore_project_board('does-not-exist', '{"columns":[]}'::jsonb)$q$, '42501', 'unknown project rejected');

END $$;

-- stranger / member / anon (separate block: the member row above is owner-workspace specific)
select test.reset();
DO $$
DECLARE
  a uuid := (select id from auth.users where email = 'rs-a@example.test');
  b uuid := (select id from auth.users where email = 'rs-b@example.test');
  m text;
BEGIN
  PERFORM test.reset();
  -- make B a real MEMBER of A's project P1 via an accepted invitation + project_members
  m := 'member-b-in-a';
  INSERT INTO public.workspace_members (id, owner_id, profile_id, full_name, initials, email)
    VALUES (m, a, b, 'B', 'B', 'rs-b@example.test');
  INSERT INTO public.project_members (project_id, member_id) VALUES ('rs1', m);

  PERFORM test.act_as(b, 'rs-b@example.test');
  PERFORM test.ok((select count(*) from public.cards where column_id like 'rs1-%') = 2, 'B is a member of P1 (can read it)');
  PERFORM test.throws($q$select public.restore_project_board('rs1', '{"columns":[]}'::jsonb)$q$, '42501', 'a plain MEMBER cannot wipe/restore the board');
  PERFORM test.reset();
  PERFORM test.ok((select count(*) from public.cards where column_id like 'rs1-%') = 2, 'board unchanged after the refused member restore');

  PERFORM test.act_as(b, 'rs-b@example.test');
  PERFORM test.throws($q$select public.restore_project_board('rs2', '{"columns":[]}'::jsonb)$q$, '42501', 'a stranger cannot restore a project they cannot see');
  PERFORM test.act_as_anon();
  PERFORM test.throws($q$select public.restore_project_board('rs1', '{"columns":[]}'::jsonb)$q$, '42501', 'anon cannot call restore');
END $$;
