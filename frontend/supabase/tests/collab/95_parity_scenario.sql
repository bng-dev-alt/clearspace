-- RUN 05 parity scenario (N12, RUN_PROMPT §2.8): the same RUN 01 user actions on a 1400 and on a 1500 database must leave EXACTLY the
-- same in-app notifications. On 1500 every user also has an ACTIVE external channel first, so the new triggers really run.
-- Prints one line "parity:<md5 of notifications>" (ids, timestamps and random tokens excluded). AUTOCOMMIT like 90-95.
\set ON_ERROR_STOP 1

DO $$
DECLARE a uuid; b uuid; c uuid;
BEGIN
  a := test.mkuser('p-own@example.test'); b := test.mkuser('p-ed@example.test'); c := test.mkuser('p-view@example.test');
  PERFORM set_config('t.a', a::text, false); PERFORM set_config('t.b', b::text, false); PERFORM set_config('t.c', c::text, false);
  IF to_regclass('public.notification_channels') IS NOT NULL THEN
    EXECUTE $q$INSERT INTO public.notification_channels (user_id, provider, status, secret_enc, label)
               SELECT u, 'telegram', 'active', 'v1.0000beef.aaaa.bbbb.cccc', 'P' FROM unnest($1::uuid[]) u$q$ USING ARRAY[a, b, c];
  END IF;
END $$;
DO $$
DECLARE r record;
BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'p-own@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pP', 'Parita');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('pP-a', 'pP', 'K udělání', 0), ('pP-d', 'pP', 'Hotovo', 1);
  INSERT INTO public.project_members (project_id, member_id) VALUES ('pP', 'member-owner-' || current_setting('t.a'));
  INSERT INTO public.cards (id, column_id, title, due_date) VALUES ('pP-k1', 'pP-a', 'Úkol jedna', '2026-12-01'), ('pP-k2', 'pP-a', 'Úkol dva', NULL);
  SELECT * INTO r FROM public.create_project_invitation('pP', 'p-ed@example.test', 'member'); PERFORM set_config('t.tb', r.token, false);
  SELECT * INTO r FROM public.create_project_invitation('pP', 'p-view@example.test', 'viewer'); PERFORM set_config('t.tc', r.token, false);
END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.b')::uuid, 'p-ed@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tb'), 'Editor Eva'); END $$;
DO $$ BEGIN PERFORM test.act_as(current_setting('t.c')::uuid, 'p-view@example.test'); PERFORM public.accept_workspace_invitation(current_setting('t.tc'), 'Čtenář Cyril'); END $$;
DO $$ BEGIN
  PERFORM set_config('t.mb', (SELECT id FROM public.workspace_members WHERE profile_id = current_setting('t.b')::uuid AND owner_id = current_setting('t.a')::uuid), false);
  PERFORM set_config('t.mc', (SELECT id FROM public.workspace_members WHERE profile_id = current_setting('t.c')::uuid AND owner_id = current_setting('t.a')::uuid), false);
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'p-own@example.test');
  INSERT INTO public.card_assignees (card_id, member_id) VALUES ('pP-k1', current_setting('t.mb')), ('pP-k1', current_setting('t.mc'));
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'p-own@example.test');
  UPDATE public.cards SET due_date = '2026-12-05', column_id = 'pP-d' WHERE id = 'pP-k1';
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.b')::uuid, 'p-ed@example.test');
  INSERT INTO public.task_comments (id, card_id, author_name, content, mentions, author_id)
  VALUES ('pc1', 'pP-k1', 'x', 'Prosím @Cyril o kontrolu', ARRAY[current_setting('t.c')::uuid], current_setting('t.b')::uuid);
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'p-own@example.test');
  INSERT INTO public.task_comments (id, card_id, author_name, content, mentions, author_id)
  VALUES ('pc2', 'pP-k1', 'x', 'Díky', '{}', current_setting('t.a')::uuid);
  PERFORM public.set_project_member('pP', current_setting('t.mb'), 'admin');
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'p-own@example.test');
  INSERT INTO public.card_assignees (card_id, member_id) VALUES ('pP-k2', current_setting('t.mc'));
END $$;
DO $$ BEGIN
  PERFORM test.act_as(current_setting('t.a')::uuid, 'p-own@example.test');
  DELETE FROM public.project_members WHERE project_id = 'pP' AND member_id = current_setting('t.mc');
END $$;

SELECT 'parity:' || md5(string_agg(x, '|' ORDER BY x)) || ' rows=' || count(*)
  FROM (SELECT u.email || '/' || n.type || '/' || coalesce(n.project_id, '-') || '/' || coalesce(n.card_id, '-') || '/' || n.title || '/' || n.actor_name
               || '/' || coalesce(n.entity_type, '-') || '/' || (n.read_at IS NULL)::text AS x
          FROM public.notifications n JOIN auth.users u ON u.id = n.recipient_id) t;
