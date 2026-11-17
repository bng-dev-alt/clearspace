-- Representative LEGACY data (plaintext invitation tokens, a project with a board, members).
-- Requires users legacy-owner@example.test and legacy-member@example.test to exist already.
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
create table test.legacy_counts as
  select 'profiles' t, count(*) n from public.profiles union all
  select 'workspace_members', count(*) from public.workspace_members union all
  select 'projects', count(*) from public.projects union all
  select 'columns', count(*) from public.columns union all
  select 'cards', count(*) from public.cards union all
  select 'task_comments', count(*) from public.task_comments union all
  select 'project_members', count(*) from public.project_members union all
  select 'invitations', count(*) from public.invitations;

-- Stray permissive policies left behind by older releases (policies are OR-ed, so a leftover would
-- silently keep the table open). The migration must remove them, not just the ones it knows by name.
create policy "legacy stray open profiles" on public.profiles for select using (true);
create policy "Users can view invitations for their email or projects" on public.invitations for select using (true);
