-- Account erasure: deleting a user who created / reviewed / consented on meeting data must work (the FK actions are ON DELETE SET NULL),
-- the meeting content must survive, and the identity guard must STILL refuse every other change of project, author or source kind.
-- Regression for the B3a finding: guard_meeting_identity rejected the FK-driven created_by -> NULL (GoTrue answered HTTP 500).
DO $$
DECLARE
  a uuid := test.mkuser('del-a@example.test');   -- project owner (stays)
  b uuid := test.mkuser('del-b@example.test');   -- member: creates, reviews, gives consent (deleted below)
  c uuid := test.mkuser('del-c@example.test');   -- second member (stays)
  rev text := repeat('c', 64);
  m1 uuid; m2 uuid; mkeep uuid; maudio uuid; r1 uuid; it uuid; n int; v_before int;
  items jsonb; run jsonb; segs jsonb;
BEGIN
  PERFORM test.act_as(a, 'del-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pDel', 'Delete creator'), ('pDel2', 'Other');
  PERFORM test.reset();
  INSERT INTO public.project_members (project_id, member_id) SELECT 'pDel', id FROM public.workspace_members WHERE profile_id IN (b, c);

  segs := jsonb_build_array(jsonb_build_object('id','seg-0','startMs',0,'endMs',5000,'speakerId','S1','text','Rozhodli jsme, že release posuneme na pátek.'));
  run := jsonb_build_object('status','succeeded','transcript_revision',rev,'input_fingerprint','fpd','contract_version','cs.meeting-brief@1.0',
           'prompt_version','meeting-brief-p1','validator_version','cs-evidence-v2','model','gemini-test','output',jsonb_build_object('summary','S'),'rejected_count',0);
  items := jsonb_build_array(jsonb_build_object('kind','decision','text','Release se posouvá na pátek.','support','linked',
           'evidence', jsonb_build_array(jsonb_build_object('ref','segment:seg-0','quote','release posuneme na pátek','quoteFound',true)),'dedupe_key',repeat('d',64)));

  -- B creates a text meeting with a transcript, an AI run and a REVIEWED item; and an audio meeting with recorded consent.
  PERFORM test.act_as(b, 'del-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pDel', 'Porada autora B', 'text') RETURNING id INTO m1;
  INSERT INTO public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count)
  VALUES (m1, 'pDel', rev, 'paste', '[{"id":"S1","label":"Mluvčí 1"}]'::jsonb, segs, 44);
  SELECT public.persist_meeting_run(m1, run, items) INTO r1;
  SELECT id INTO it FROM public.intelligence_items WHERE run_id = r1;
  PERFORM public.review_intelligence_item(it, 'accept');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pDel', 'Audio porada autora B', 'audio') RETURNING id INTO maudio;
  PERFORM public.record_audio_consent(maudio);
  PERFORM test.ok((select created_by from public.meetings where id = m1) = b
              AND (select created_by from public.meeting_transcripts where meeting_id = m1) = b
              AND (select created_by from public.intelligence_runs where id = r1) = b
              AND (select decided_by from public.intelligence_items where id = it) = b
              AND (select consent_by from public.meetings where id = maudio) = b, 'setup: the user B authored a meeting, a transcript, a run, a reviewed item and a consent');
  PERFORM test.act_as(c, 'del-c@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pDel', 'Porada člena C', 'text') RETURNING id INTO mkeep;

  -- ---- the identity guard still protects authorship while the author exists ----------------------------------------
  PERFORM test.reset();
  PERFORM test.throws(format($q$update public.meetings set created_by = %L where id = %L$q$, c, m1), '42501', 'authorship cannot be reassigned to another user (even by the table owner)');
  PERFORM test.throws(format($q$update public.meetings set created_by = NULL where id = %L$q$, m1), '42501', 'authorship cannot be wiped while the author still exists');
  PERFORM test.throws(format($q$update public.meetings set project_id = 'pDel2' where id = %L$q$, m1), '42501', 'a meeting cannot be moved to another project (trigger)');
  PERFORM test.throws(format($q$update public.meetings set source_kind = 'audio' where id = %L$q$, m1), '42501', 'source kind cannot change (trigger)');
  PERFORM test.act_as(b, 'del-b@example.test');
  PERFORM test.throws(format($q$update public.meetings set created_by = NULL where id = %L$q$, m1), '42501', 'authenticated users have no privilege to change created_by');
  PERFORM test.throws(format($q$update public.meetings set created_by = %L where id = %L$q$, c, m1), '42501', 'authenticated users cannot reassign created_by');
  PERFORM test.reset();

  -- ---- erasure: delete the AUTHOR's account ----------------------------------------------------------------------------
  SELECT count(*) INTO v_before FROM public.meetings WHERE project_id = 'pDel';
  DELETE FROM auth.users WHERE id = b;
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM auth.users WHERE id = b) AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = b), 'the author account and profile are gone');
  PERFORM test.ok((select count(*) from public.meetings where project_id = 'pDel') = v_before, 'no meeting was deleted with the account');
  PERFORM test.ok((select created_by is null from public.meetings where id = m1), 'meetings.created_by became NULL');
  PERFORM test.ok((select created_by is null from public.meeting_transcripts where meeting_id = m1), 'meeting_transcripts.created_by became NULL');
  PERFORM test.ok((select created_by is null from public.intelligence_runs where id = r1), 'intelligence_runs.created_by became NULL');
  PERFORM test.ok((select decided_by is null and review_state = 'accepted' from public.intelligence_items where id = it), 'items.decided_by became NULL, the review outcome is kept');
  PERFORM test.ok((select consent_by is null and consent_at is not null from public.meetings where id = maudio), 'meetings.consent_by became NULL, the recorded consent time is kept');
  PERFORM test.ok((select title from public.meetings where id = m1) = 'Porada autora B' AND (select count(*) from public.meeting_transcripts where meeting_id = m1) = 1, 'meeting content (title, transcript) survived');
  PERFORM test.ok((select created_by from public.meetings where id = mkeep) = c, 'meetings of other users are untouched');

  -- ---- after the erasure the orphaned meeting is still governed by the guard and the owner can still manage it -------------
  PERFORM test.throws(format($q$update public.meetings set created_by = %L where id = %L$q$, c, m1), '42501', 'an orphaned meeting cannot be given a new author either');
  PERFORM test.throws(format($q$update public.meetings set project_id = 'pDel2' where id = %L$q$, m1), '42501', 'an orphaned meeting still cannot be moved');
  PERFORM test.act_as(a, 'del-a@example.test');
  UPDATE public.meetings SET title = 'Přejmenováno vlastníkem' WHERE id = m1; GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 1, 'the project owner can still edit the orphaned meeting');
  DELETE FROM public.meetings WHERE id = m1; GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 1, 'the project owner can delete the orphaned meeting');

  -- ---- a second erasure with nothing left to null, and the member who keeps authorship --------------------------------
  PERFORM test.reset();
  DELETE FROM auth.users WHERE id = c;
  PERFORM test.ok((select created_by is null from public.meetings where id = mkeep), 'deleting a second author nulls their meeting too');
  PERFORM test.ok((select count(*) from public.meetings where id = mkeep) = 1, 'and keeps it');
END $$;
