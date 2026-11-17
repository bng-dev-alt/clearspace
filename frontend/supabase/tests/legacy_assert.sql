-- Assertions after the migrations were applied on top of the legacy data (run inside begin/rollback).
do $$
declare bad text := ''; r record;
begin
  for r in select t, n from test.legacy_counts loop
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
  perform test.ok((select count(*) from pg_policies where schemaname='public' and (policyname like '%stray%' or policyname = 'Users can view invitations for their email or projects')) = 0, 'stray permissive policies from older releases were removed');
  perform test.act_as_anon();
  perform test.ok((select state from public.invitation_preview('LEGACYTOKENpending1AAAAAAAAAAAAAA')) = 'used', 'old pending link no longer usable');
  perform test.throws('select * from public.profiles', '42501', 'anon cannot read profiles after upgrade');
  perform test.reset();
  perform test.act_as((select id from auth.users where email='legacy-member@example.test'), 'legacy-member@example.test');
  perform test.ok((select count(*) from public.profiles) = 1, 'a member sees only their own profile after the upgrade (no stray open policy)');
  perform test.ok((select count(*) from (select id from public.invitations) s) = 0, 'a member cannot read the owner invitations after the upgrade');
  perform test.ok((select count(*) from public.projects where id='legacy-p1') = 1, 'existing project member keeps access after upgrade');
  perform test.ok((select count(*) from public.cards) = 25, 'existing member still reads the board');
  perform test.reset();
  perform test.act_as((select id from auth.users where email='legacy-owner@example.test'), 'legacy-owner@example.test');
  perform test.ok((select count(*) from public.workspace_members where owner_id = auth.uid()) = 2, 'owner still sees own members');
end $$;
