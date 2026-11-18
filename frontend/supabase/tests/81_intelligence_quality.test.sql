-- Intelligence quality (R6): column roles, transcript revision lineage and quota, meeting quotas, freshness stamp.
DO $$
DECLARE
  a uuid := test.mkuser('q-a@example.test');   -- project owner
  b uuid := test.mkuser('q-b@example.test');   -- project member
  c uuid := test.mkuser('q-c@example.test');   -- stranger
  m1 uuid; m2 uuid;
  rev1 text := md5('r1') || md5('r1b');
  rev2 text := md5('r2') || md5('r2b');
  segs jsonb := jsonb_build_array(jsonb_build_object('id', 'seg-0', 'startMs', 0, 'endMs', 1000, 'speakerId', 'S1', 'text', 'Ahoj světe.'));
  s0 text; s1 text; s2 text; s3 text; s4 text; s5 text;
  n int; i int;
BEGIN
  PERFORM test.act_as(a, 'q-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pQ', 'Quality'), ('pQ2', 'Quota');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('pQ-c1', 'pQ', 'Todo', 0), ('pQ-c2', 'pQ', 'Hotovo', 1);
  INSERT INTO public.cards (id, column_id, title) VALUES ('pQ-k1', 'pQ-c1', 'Karta 1');
  PERFORM test.reset();
  INSERT INTO public.project_members (project_id, member_id) SELECT 'pQ', id FROM public.workspace_members WHERE profile_id = b;
  INSERT INTO public.project_members (project_id, member_id) SELECT 'pQ2', id FROM public.workspace_members WHERE profile_id = b;

  -- ================= column roles =================
  PERFORM test.act_as(a, 'q-a@example.test');
  PERFORM test.ok((select role from public.columns where id = 'pQ-c1') IS NULL, 'a freshly created column has no explicit role (the app falls back to the name heuristic)');
  UPDATE public.columns SET role = 'doing' WHERE id = 'pQ-c1';
  UPDATE public.columns SET role = 'done' WHERE id = 'pQ-c2';
  PERFORM test.ok((select role from public.columns where id = 'pQ-c2') = 'done', 'the owner can set a semantic role');
  PERFORM test.throws($q$update public.columns set role = 'bogus' where id = 'pQ-c1'$q$, '23514', 'an unknown role is refused');
  UPDATE public.columns SET role = NULL WHERE id = 'pQ-c1';
  PERFORM test.ok((select role from public.columns where id = 'pQ-c1') IS NULL, 'a role can be cleared again');
  PERFORM test.act_as(c, 'q-c@example.test');
  UPDATE public.columns SET role = 'todo' WHERE id = 'pQ-c1'; GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'a stranger cannot change a column role (RLS)');

  -- ================= transcript lineage =================
  PERFORM test.act_as(b, 'q-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pQ', 'Porada A', 'text') RETURNING id INTO m1;
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pQ', 'Porada B', 'text') RETURNING id INTO m2;
  INSERT INTO public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count)
    VALUES (m1, 'pQ', rev1, 'paste', '[]', segs, 11);
  INSERT INTO public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count, parent_revision, edit_note)
    VALUES (m1, 'pQ', rev2, 'edit', '[]', segs, 11, rev1, 'Opraveno jméno');
  PERFORM test.ok((select current_revision from public.meetings where id = m1) = rev2, 'an edit becomes the current revision');
  PERFORM test.ok((select count(*) from public.meeting_transcripts where meeting_id = m1) = 2, 'the earlier revision stays stored (history)');
  PERFORM test.ok((select parent_revision from public.meeting_transcripts where meeting_id = m1 and revision = rev2) = rev1, 'lineage points at the parent revision');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count) values (%L, 'pQ', %L, 'edit', '[]', %L, 11)$q$, m1, md5('x') || md5('y'), segs), '22023', 'an edit without a parent revision is refused');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count, parent_revision) values (%L, 'pQ', %L, 'edit', '[]', %L, 11, %L)$q$, m2, md5('x') || md5('y'), segs, rev1), '23503', 'a parent revision of ANOTHER meeting is refused (composite FK)');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count, parent_revision) values (%L, 'pQ', %L, 'edit', '[]', %L, 11, %L)$q$, m1, rev1, segs, rev2), '23505', 'an existing revision cannot be inserted again (immutable, same content = same id)');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count, parent_revision) values (%L, 'pQ', %L, 'edit', '[]', %L, 11, %L)$q$, m1, rev1, segs, rev1), '22023', 'a revision cannot be its own parent');
  PERFORM test.throws(format($q$update public.meeting_transcripts set edit_note = 'x' where meeting_id = %L$q$, m1), '42501', 'revisions are immutable (no UPDATE privilege)');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count, edit_note) values (%L, 'pQ', %L, 'paste', '[]', %L, 11, repeat('x', 501))$q$, m2, md5('z') || md5('w'), segs), '23514', 'an over-long edit note is refused');
  -- revision quota (25 per meeting): m1 already has 2
  FOR i IN 3..25 LOOP
    INSERT INTO public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count, parent_revision)
      VALUES (m1, 'pQ', md5('q' || i) || md5('Q' || i), 'edit', '[]', segs, 11, rev2);
  END LOOP;
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count, parent_revision) values (%L, 'pQ', %L, 'edit', '[]', %L, 11, %L)$q$, m1, md5('over') || md5('Over'), segs, rev2), 'PT429', 'the 26th revision of one meeting is refused (quota)');
  PERFORM test.act_as(c, 'q-c@example.test');
  PERFORM test.ok((select count(*) from public.meeting_transcripts) = 0, 'a stranger sees no revisions');

  -- ================= meeting quotas =================
  -- per user per day: b already created 2 meetings today; 38 more are allowed, the 41st is refused
  PERFORM test.act_as(b, 'q-b@example.test');
  FOR i IN 1..38 LOOP
    INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pQ2', 'M' || i, 'text');
  END LOOP;
  PERFORM test.throws($q$insert into public.meetings (project_id, title, source_kind) values ('pQ2', 'over', 'text')$q$, 'PT429', 'the daily per-user meeting quota (40) is enforced');
  -- per project: fill the project to 500 as a system actor (no created_by, so the per-user rule does not apply)
  PERFORM test.reset();
  INSERT INTO public.meetings (project_id, title, source_kind)
    SELECT 'pQ2', 'bulk ' || g, 'text' FROM generate_series(1, 500 - (select count(*) from public.meetings where project_id = 'pQ2')::int) g;
  PERFORM test.ok((select count(*) from public.meetings where project_id = 'pQ2') = 500, 'project filled to the 500-meeting limit');
  PERFORM test.throws($q$insert into public.meetings (project_id, title, source_kind) values ('pQ2', 'one too many', 'text')$q$, 'PT429', 'the per-project meeting quota (500) is enforced');
  PERFORM test.ok((public.intelligence_limits() ->> 'max_meetings_per_project')::int = 500, 'limits are exposed by one function');

  -- ================= freshness stamp =================
  PERFORM test.act_as(a, 'q-a@example.test');
  s0 := public.project_intelligence_stamp('pQ');
  PERFORM test.ok(s0 ~ '^[0-9a-f]{32}$', 'stamp is a 32-hex fingerprint');
  PERFORM test.ok(s0 = public.project_intelligence_stamp('pQ'), 'stamp is stable when nothing changes');
  INSERT INTO public.task_comments (id, card_id, author_name, content) VALUES ('pQ-cm1', 'pQ-k1', 'A', 'Nový komentář');
  s1 := public.project_intelligence_stamp('pQ');
  PERFORM test.ok(s1 <> s0, 'a COMMENT-only change changes the stamp (the old signature missed it)');
  INSERT INTO public.task_checklists (id, card_id, text) VALUES ('pQ-ch1', 'pQ-k1', 'Krok');
  s2 := public.project_intelligence_stamp('pQ');
  PERFORM test.ok(s2 <> s1, 'adding a checklist item changes the stamp');
  UPDATE public.task_checklists SET completed = true WHERE id = 'pQ-ch1';
  s3 := public.project_intelligence_stamp('pQ');
  PERFORM test.ok(s3 <> s2, 'completing a checklist item changes the stamp');
  UPDATE public.columns SET role = 'review' WHERE id = 'pQ-c1';
  s4 := public.project_intelligence_stamp('pQ');
  PERFORM test.ok(s4 <> s3, 'changing a column role changes the stamp');
  s5 := public.project_intelligence_stamp('pQ');
  PERFORM test.ok(s5 = s4, 'and it is stable again afterwards');
  PERFORM test.act_as(c, 'q-c@example.test');
  PERFORM test.ok(public.project_intelligence_stamp('pQ') <> s5, 'a stranger gets a different stamp (RLS hides the rows: no information leak about counts)');
  PERFORM test.act_as_anon();
  PERFORM test.throws($q$select public.project_intelligence_stamp('pQ')$q$, '42501', 'anon cannot call the stamp');
END $$;
