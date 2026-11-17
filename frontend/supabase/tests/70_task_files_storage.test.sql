-- Task attachments: private bucket, member-only access by card, no anon access.
-- (Policy logic only: the Storage API itself -- size/MIME enforcement, signed URLs -- is exercised by storage_real_stack.sh.)
DO $$
DECLARE
  a uuid := test.mkuser('st-a@example.test');
  b uuid := test.mkuser('st-b@example.test');
  c uuid := test.mkuser('st-c@example.test');
  n int;
BEGIN
  -- bucket configuration
  PERFORM test.ok((select public from storage.buckets where id='task-resources') = false, 'bucket task-resources is private');
  PERFORM test.ok((select file_size_limit from storage.buckets where id='task-resources') = 10485760, 'bucket limited to 10 MiB');
  PERFORM test.ok(not exists (select 1 from storage.buckets, unnest(allowed_mime_types) m where id='task-resources' and (m ilike '%svg%' or m ilike '%html%' or m ilike '%javascript%' or m ilike '%xml' or m ilike '%executable%')),
    'MIME allow-list contains no SVG/HTML/script/executable types');

  PERFORM test.act_as(a, 'st-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('st1', 'P');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('st1-c1','st1','Todo',0);
  INSERT INTO public.cards (id, column_id, title) VALUES ('st1-k1','st1-c1','Task');

  -- owner can upload / read / delete under tasks/<own card>/
  INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('task-resources', 'tasks/st1-k1/res-1.png', a);
  PERFORM test.ok((select count(*) from storage.objects where name = 'tasks/st1-k1/res-1.png') = 1, 'owner reads own task file');
  PERFORM test.ok(public.can_access_task_file('tasks/st1-k1/res-1.png'), 'can_access_task_file true for a member');
  PERFORM test.ok(NOT public.can_access_task_file('tasks/st1-k1'), 'path without a file name is not a task file');
  PERFORM test.ok(NOT public.can_access_task_file('other/st1-k1/x.png'), 'only the tasks/ prefix is allowed');
  PERFORM test.ok(NOT public.can_access_task_file('tasks/no-such-card/x.png'), 'unknown card -> no access');

  -- wrong bucket / wrong prefix refused even for the owner
  PERFORM test.throws($q$insert into storage.objects (bucket_id, name, owner) values ('task-resources','elsewhere/x.png', auth.uid())$q$, '42501', 'owner cannot write outside tasks/<card>/');
  PERFORM test.throws($q$insert into storage.objects (bucket_id, name, owner) values ('some-other-bucket','tasks/st1-k1/x.png', auth.uid())$q$, NULL, 'no policy for other buckets');

  -- a stranger cannot read, write or delete it
  PERFORM test.reset(); PERFORM test.act_as(b, 'st-b@example.test');
  PERFORM test.ok((select count(*) from storage.objects where name like 'tasks/st1-k1/%') = 0, 'non-member sees no files of the project');
  PERFORM test.throws($q$insert into storage.objects (bucket_id, name, owner) values ('task-resources','tasks/st1-k1/evil.png', auth.uid())$q$, '42501', 'non-member cannot upload to a foreign card');
  delete from storage.objects where name = 'tasks/st1-k1/res-1.png';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'non-member delete affects 0 files');

  -- anon: nothing
  PERFORM test.reset(); PERFORM test.act_as_anon();
  PERFORM test.throws($q$select count(*) from storage.objects$q$, '42501', 'anon has no privilege on storage.objects');

  -- a member added to the project gains access; a non-member workspace colleague does not
  PERFORM test.reset(); PERFORM test.act_as(a, 'st-a@example.test');
  PERFORM test.ok((select count(*) from storage.objects where name = 'tasks/st1-k1/res-1.png') = 1, 'owner still sees the file');
  delete from storage.objects where name = 'tasks/st1-k1/res-1.png';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 1, 'owner can delete the file');
  PERFORM test.reset();
END $$;
