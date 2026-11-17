#!/usr/bin/env bash
# Scenario B: upgrade of a database that already holds representative LEGACY data
# (plaintext invitation tokens, projects, boards, members). Proves the migration
# preserves rows, retires weak pending invitations and erases plaintext tokens.
# Sourced by run.sh (uses its newdb/apply/psql_admin helpers and $BASELINE/$MIGRATIONS).

echo "== Scenario B: upgrade of an existing database with legacy data"
newdb cs_b
apply cs_b "$BASELINE"

psql_admin -d cs_b -f - >/dev/null <<'SQL'
select test.mkuser('legacy-owner@example.test');
select test.mkuser('legacy-member@example.test');
do $$
declare o uuid := (select id from auth.users where email='legacy-owner@example.test');
        m uuid := (select id from auth.users where email='legacy-member@example.test');
begin
  insert into public.projects (id, name, user_id) values ('legacy-p1', 'Legacy', o);
  insert into public.columns (id, project_id, name, position) values ('legacy-c1','legacy-p1','Todo',0),('legacy-c2','legacy-p1','Done',1);
  insert into public.cards (id, column_id, title) select 'legacy-k'||g, 'legacy-c1', 'Card '||g from generate_series(1,25) g;
  insert into public.task_comments (id, card_id, author_name, content) values ('lc1','legacy-k1','Owner','hello');
  insert into public.workspace_members (id, owner_id, profile_id, full_name, initials, email) values ('legacy-m1', o, m, 'Legacy Member', 'LM', 'legacy-member@example.test');
  insert into public.project_members (project_id, member_id) values ('legacy-p1','legacy-m1');
  -- legacy invitations: PLAINTEXT tokens
  insert into public.invitations (id, workspace_id, email, token, role, status, invited_by, expires_at) values
   ('li1', o, 'pending1@example.test', 'LEGACYTOKENpending1AAAAAAAAAAAAAA', 'member', 'pending',  o, now()+interval '5 days'),
   ('li2', o, 'pending2@example.test', 'LEGACYTOKENpending2BBBBBBBBBBBBBB', 'member', 'pending',  o, now()+interval '5 days'),
   ('li3', o, 'done@example.test',     'LEGACYTOKENaccepted3CCCCCCCCCCCCCC', 'member', 'accepted', o, now()+interval '5 days'),
   ('li4', o, 'rev@example.test',      'LEGACYTOKENrejected4DDDDDDDDDDDDDD', 'member', 'rejected', o, now()+interval '5 days');
end $$;
create table public.legacy_counts as
  select 'profiles' t, count(*) n from public.profiles union all
  select 'workspace_members', count(*) from public.workspace_members union all
  select 'projects', count(*) from public.projects union all
  select 'columns', count(*) from public.columns union all
  select 'cards', count(*) from public.cards union all
  select 'task_comments', count(*) from public.task_comments union all
  select 'project_members', count(*) from public.project_members union all
  select 'invitations', count(*) from public.invitations;
SQL

apply cs_b "${MIGRATIONS[@]}"

echo "--- legacy upgrade assertions"
{ echo "begin;"; cat <<'SQL'
do $$
declare bad text := ''; r record;
begin
  for r in select t, n from public.legacy_counts loop
    if (select count(*) from (select 1) s) = 1 and
       (case r.t
          when 'profiles' then (select count(*) from public.profiles)
          when 'workspace_members' then (select count(*) from public.workspace_members)
          when 'projects' then (select count(*) from public.projects)
          when 'columns' then (select count(*) from public.columns)
          when 'cards' then (select count(*) from public.cards)
          when 'task_comments' then (select count(*) from public.task_comments)
          when 'project_members' then (select count(*) from public.project_members)
          when 'invitations' then (select count(*) from public.invitations) end) <> r.n then
      bad := bad || ' ' || r.t;
    end if;
  end loop;
  perform test.ok(bad = '', 'no rows lost or added by the migration' || bad);
  perform test.ok((select count(*) from public.invitations where status = 'pending') = 0, 'weak pending invitations were retired');
  perform test.ok((select status from public.invitations where id='li1') = 'expired', 'pending -> expired (owner must re-invite)');
  perform test.ok((select status from public.invitations where id='li3') = 'accepted', 'accepted history preserved');
  perform test.ok((select status from public.invitations where id='li4') = 'rejected', 'revoked history preserved');
  perform test.ok((select count(*) from public.invitations where token is not null) = 0, 'every plaintext token was erased');
  perform test.ok((select token_hash from public.invitations where id='li3') = encode(extensions.digest('LEGACYTOKENaccepted3CCCCCCCCCCCCCC','sha256'),'hex'), 'legacy rows keep sha256 of their token');
  perform test.ok((select count(*) from public.cards where column_id='legacy-c1') = 25, 'board content intact');
  perform test.act_as_anon();
  perform test.ok((select state from public.invitation_preview('LEGACYTOKENpending1AAAAAAAAAAAAAA')) = 'used', 'old pending link no longer usable');
  perform test.throws('select * from public.profiles', '42501', 'anon cannot read profiles after upgrade');
  perform test.reset();
  perform test.act_as((select id from auth.users where email='legacy-member@example.test'), 'legacy-member@example.test');
  perform test.ok((select count(*) from public.projects where id='legacy-p1') = 1, 'existing project member keeps access after upgrade');
  perform test.ok((select count(*) from public.cards) = 25, 'existing member still reads the board');
  perform test.reset();
  perform test.act_as((select id from auth.users where email='legacy-owner@example.test'), 'legacy-owner@example.test');
  perform test.ok((select count(*) from public.workspace_members where owner_id = auth.uid()) = 2, 'owner still sees own members');
end $$;
SQL
echo "rollback;"; } | docker exec -i -e PGPASSWORD=sectest clearspace-v1-sectest psql -h localhost -U supabase_admin -v ON_ERROR_STOP=1 -q -d cs_b -f - 2>&1 | grep -E "NOTICE:  ok|ERROR|FAIL" | sed -E 's/^.*NOTICE:  //'
[ "${PIPESTATUS[1]}" -eq 0 ] || { echo "FAIL: legacy upgrade assertions"; exit 1; }
