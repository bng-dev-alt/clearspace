-- Meeting audio (R5): consent, storage isolation, upload registration, Soniox job state machine, idempotency,
-- budgets, provenance guard, retention. No provider is contacted: these are the database RPCs only.
DO $$
DECLARE
  a uuid := test.mkuser('au-a@example.test');   -- project owner
  b uuid := test.mkuser('au-b@example.test');   -- project member
  c uuid := test.mkuser('au-c@example.test');   -- stranger
  v_real boolean := to_regprocedure('storage.protect_delete()') IS NOT NULL;
  mA uuid; mB uuid; mT uuid; mC uuid;
  pathA text; pathA2 text;
  r record; t1 timestamptz; t2 timestamptz;
  n int; req uuid; req2 uuid; rev text; rev2 text;
  tr jsonb;
  hrs int := 3600000;
BEGIN
  PERFORM test.act_as(a, 'au-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pAu', 'Audio');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('pAu-c1', 'pAu', 'Todo', 0);
  PERFORM test.act_as(c, 'au-c@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pAuC', 'Stranger');
  PERFORM test.reset();
  INSERT INTO public.project_members (project_id, member_id) SELECT 'pAu', id FROM public.workspace_members WHERE profile_id = b;

  -- ---- bucket configuration -----------------------------------------------------------------------------------------
  PERFORM test.ok((select public from storage.buckets where id = 'meeting-audio') = false, 'bucket meeting-audio is private');
  PERFORM test.ok((select file_size_limit from storage.buckets where id = 'meeting-audio') = 52428800, 'bucket limited to 50 MiB');
  PERFORM test.ok(not exists (select 1 from storage.buckets, unnest(allowed_mime_types) m where id = 'meeting-audio' and m !~ '^audio/'), 'only audio MIME types are allowed (no video/html/svg/script)');

  -- ---- consent ------------------------------------------------------------------------------------------------------
  PERFORM test.act_as(b, 'au-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pAu', 'Audio porada', 'audio') RETURNING id INTO mA;
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pAu', 'Druhá', 'audio') RETURNING id INTO mB;
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pAu', 'Textová', 'text') RETURNING id INTO mT;
  PERFORM test.ok((select stt_state from public.meetings where id = mA) = 'none' AND (select consent_at from public.meetings where id = mA) IS NULL, 'a new audio meeting has no consent and no job');
  PERFORM test.throws($q$update public.meetings set consent_at = now() where title = 'Audio porada'$q$, '42501', 'a client cannot write consent directly (no column privilege)');
  PERFORM test.throws($q$update public.meetings set stt_state = 'completed' where title = 'Audio porada'$q$, '42501', 'a client cannot write the STT state directly');
  PERFORM test.throws(format('select public.record_audio_consent(%L)', mT), '22023', 'consent is only recorded for audio meetings');
  PERFORM test.act_as(c, 'au-c@example.test');
  PERFORM test.throws(format('select public.record_audio_consent(%L)', mA), '42501', 'a stranger cannot record consent');
  PERFORM test.act_as_anon();
  PERFORM test.throws(format('select public.record_audio_consent(%L)', mA), '42501', 'anon cannot call the consent RPC');
  PERFORM test.act_as(b, 'au-b@example.test');
  -- nothing can be uploaded BEFORE consent
  pathA := 'pAu/' || mA || '/' || gen_random_uuid() || '.mp3';
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{"size":1000}')$q$, pathA), '42501', 'upload is refused until consent is recorded (Storage policy)');
  t1 := public.record_audio_consent(mA);
  PERFORM test.ok(t1 IS NOT NULL AND (select consent_by from public.meetings where id = mA) = b, 'consent is recorded with the person who gave it');
  PERFORM pg_sleep(0.01);
  t2 := public.record_audio_consent(mA);
  PERFORM test.ok(t1 = t2 AND (select consent_by from public.meetings where id = mA) = b, 'consent is idempotent: the first consent stands');

  -- ---- storage isolation --------------------------------------------------------------------------------------------
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pathA, b, '{"size":1000,"mimetype":"audio/mpeg"}');
  PERFORM test.ok((select count(*) from storage.objects where name = pathA) = 1, 'member uploads and reads audio of a consented meeting');
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{}')$q$, 'pAuC/' || mA || '/' || gen_random_uuid() || '.mp3'), '42501', 'a path whose project does not own the meeting is refused');
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{}')$q$, 'pAu/' || mA || '/sub/' || gen_random_uuid() || '.mp3'), '42501', 'a path with extra folders is refused');
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{}')$q$, 'pAu/' || mT || '/' || gen_random_uuid() || '.mp3'), '42501', 'a TEXT meeting cannot hold audio');
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{}')$q$, 'pAu/' || mB || '/' || gen_random_uuid() || '.mp3'), '42501', 'another meeting WITHOUT consent still refuses uploads');
  PERFORM test.act_as(c, 'au-c@example.test');
  PERFORM test.ok((select count(*) from storage.objects where bucket_id = 'meeting-audio') = 0, 'a stranger sees no audio objects');
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{}')$q$, 'pAu/' || mA || '/' || gen_random_uuid() || '.mp3'), '42501', 'a stranger cannot upload into a foreign meeting');
  PERFORM test.act_as_anon();
  BEGIN SELECT count(*) INTO n FROM storage.objects; EXCEPTION WHEN insufficient_privilege THEN n := 0; END;
  PERFORM test.ok(n = 0, 'anon sees no audio objects');

  -- ---- attach_meeting_audio -----------------------------------------------------------------------------------------
  PERFORM test.act_as(b, 'au-b@example.test');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, 'pAu/x/y.mp3', 1000, 'audio/mpeg', 1000)$q$, mA), '22023', 'a malformed path is refused');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 1000, 'video/mp4', 1000)$q$, mA, pathA), '22023', 'a non-audio MIME type is refused');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 999, 'audio/mpeg', 1000)$q$, mA, pathA), '22023', 'a size that does not match the stored object is refused');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 1000, 'audio/mpeg', 99999999)$q$, mA, pathA), '22023', 'more than 300 minutes is refused');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 1000, 'audio/mpeg', 1000)$q$, mA, 'pAu/' || mA || '/' || gen_random_uuid() || '.mp3'), '22023', 'an object that is not in the bucket is refused');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 1000, 'audio/mpeg', 1000)$q$, mB, pathA), '55000', 'attach without consent is refused');
  PERFORM test.act_as(c, 'au-c@example.test');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 1000, 'audio/mpeg', 1000)$q$, mA, pathA), '42501', 'a stranger cannot attach');
  PERFORM test.act_as(b, 'au-b@example.test');
  PERFORM test.ok(public.attach_meeting_audio(mA, pathA, 1000, 'audio/mpeg', 60000) IS NULL, 'first attach succeeds and there is no previous file');
  PERFORM test.ok((select status from public.meetings where id = mA) = 'uploaded' AND (select audio_path from public.meetings where id = mA) = pathA, 'the meeting is now uploaded');
  -- replacing the file returns the previous path (so the caller can delete it)
  pathA2 := 'pAu/' || mA || '/' || gen_random_uuid() || '.wav';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pathA2, b, '{"size":2000,"mimetype":"audio/wav"}');
  PERFORM test.ok(public.attach_meeting_audio(mA, pathA2, 2000, 'audio/wav', 120000) = pathA, 'replacing the audio returns the previous path for deletion');

  -- ---- stt_reserve ---------------------------------------------------------------------------------------------------
  PERFORM test.throws(format('select * from public.stt_reserve(%L, 0, 1000000, 1000000)', mA), '22023', 'zero estimated duration is refused');
  PERFORM test.throws(format('select * from public.stt_reserve(%L, 99999999, 1000000, 1000000)', mA), '22023', 'more than 300 minutes is refused');
  SELECT * INTO r FROM public.stt_reserve(mB, 60000, 7200000, 36000000);
  PERFORM test.ok(r.outcome = 'no_consent', 'no job without consent');
  PERFORM public.record_audio_consent(mB);
  SELECT * INTO r FROM public.stt_reserve(mB, 60000, 7200000, 36000000);
  PERFORM test.ok(r.outcome = 'no_audio', 'no job without an uploaded file');
  PERFORM test.act_as(c, 'au-c@example.test');
  PERFORM test.throws(format('select * from public.stt_reserve(%L, 60000, 7200000, 36000000)', mA), '42501', 'a stranger cannot start a transcription');
  PERFORM test.act_as(b, 'au-b@example.test');
  -- budgets
  SELECT * INTO r FROM public.stt_reserve(mA, 120000, 60000, 36000000);
  PERFORM test.ok(r.outcome = 'budget_exceeded', 'the per-user daily audio budget is enforced');
  SELECT * INTO r FROM public.stt_reserve(mA, 120000, 7200000, 60000);
  PERFORM test.ok(r.outcome = 'global_budget_exceeded', 'the global daily audio budget is enforced');
  PERFORM test.ok((select count(*) from public.ai_requests where feature = 'meeting-transcribe') = 0, 'refused reservations book nothing');
  -- start
  SELECT * INTO r FROM public.stt_reserve(mA, 120000, 7200000, 36000000);
  req := r.request_id;
  PERFORM test.ok(r.outcome = 'started' AND r.attempt = 1 AND r.audio_path = pathA2 AND r.audio_mime = 'audio/wav' AND r.project_id = 'pAu', 'a transcription is started with the stored audio path');
  PERFORM test.ok((select stt_state from public.meetings where id = mA) = 'submitting' AND (select status from public.meetings where id = mA) = 'transcribing', 'state machine: submitting');
  PERFORM test.ok((select provider || ':' || audio_ms || ':' || status from public.ai_requests where id = req) = 'soniox:120000:reserved', 'the ledger row is booked with provider and the audio estimate');
  -- duplicate start is idempotent
  SELECT * INTO r FROM public.stt_reserve(mA, 120000, 7200000, 36000000);
  PERFORM test.ok(r.outcome = 'in_progress' AND r.request_id = req, 'a duplicate start reports in_progress and returns the same request');
  PERFORM test.ok((select count(*) from public.ai_requests where feature = 'meeting-transcribe') = 1, 'a duplicate start books nothing and submits nothing');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 2000, 'audio/wav', 1)$q$, mA, pathA2), '55000', 'audio cannot be replaced while a job runs');

  -- ---- stt_attach_job -----------------------------------------------------------------------------------------------
  PERFORM test.throws(format($q$select public.stt_attach_job(%L, '', 'stt-async-v6')$q$, mA), '22023', 'an empty job id is refused');
  PERFORM public.stt_attach_job(mA, 'job-1', 'stt-async-v6');
  PERFORM test.ok((select stt_state || ':' || stt_job_id || ':' || stt_model || ':' || stt_provider from public.meetings where id = mA) = 'transcribing:job-1:stt-async-v6:soniox', 'state machine: transcribing with job id and model');
  PERFORM public.stt_attach_job(mA, 'job-1', 'stt-async-v6');
  PERFORM test.ok(true, 'attaching the same job twice is idempotent');
  PERFORM test.throws(format($q$select public.stt_attach_job(%L, 'job-2', 'stt-async-v6')$q$, mA), '55000', 'a different job cannot replace a running one');
  SELECT * INTO r FROM public.stt_reserve(mA, 120000, 7200000, 36000000);
  PERFORM test.ok(r.outcome = 'in_progress', 'while transcribing a new start is in_progress');

  -- ---- provenance guard + stt_complete -----------------------------------------------------------------------------
  rev := md5('soniox1') || md5('soniox2');
  tr := jsonb_build_object('revision', rev, 'char_count', 40,
        'speakers', jsonb_build_array(jsonb_build_object('id', 'S1', 'label', 'Mluvčí 1', 'displayName', null)),
        'segments', jsonb_build_array(jsonb_build_object('id', 'seg-0-0', 'startMs', 0, 'endMs', 4000, 'speakerId', 'S1', 'text', 'Ahoj, začneme poradou.')),
        'coverage', jsonb_build_object('gaps', 0));
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count) values (%L, 'pAu', %L, 'soniox', '[]', '[{"id":"s","text":"forged"}]', 6)$q$, mA, md5('forge') || md5('forge2')), '42501', 'a member cannot forge a machine transcript with a direct INSERT');
  PERFORM test.throws(format($q$select public.stt_complete(%L, 'wrong-job', 'stt-async-v6', 4000, %L::jsonb)$q$, mA, tr::text), '55000', 'completion with a different job id is refused');
  PERFORM test.throws(format($q$select public.stt_complete(%L, 'job-1', 'stt-async-v6', 4000, %L::jsonb)$q$, mA, (tr - 'revision')::text), '22023', 'a transcript without a revision is refused');
  PERFORM test.act_as(c, 'au-c@example.test');
  PERFORM test.throws(format($q$select public.stt_complete(%L, 'job-1', 'stt-async-v6', 4000, %L::jsonb)$q$, mA, tr::text), '42501', 'a stranger cannot complete a job');
  PERFORM test.act_as(b, 'au-b@example.test');
  rev2 := public.stt_complete(mA, 'job-1', 'stt-async-v6', hrs, tr);
  PERFORM test.ok(rev2 = rev, 'stt_complete returns the revision id');
  PERFORM test.ok((select count(*) from public.meeting_transcripts where meeting_id = mA and source = 'soniox') = 1, 'the machine transcript is stored once as source soniox');
  PERFORM test.ok((select stt_state || ':' || status || ':' || current_revision from public.meetings where id = mA) = 'completed:transcribed:' || rev, 'meeting is transcribed and points at the new revision');
  PERFORM test.ok((select stt_audio_ms = hrs AND stt_cost_usd = 0.1000 AND stt_cleanup_pending from public.meetings where id = mA), 'actual duration and the cost estimate are booked; provider cleanup is pending');
  PERFORM test.ok((select audio_delete_after > now() + interval '6 days 23 hours' and audio_delete_after < now() + interval '7 days 1 hour' from public.meetings where id = mA), 'audio retention defaults to 7 days');
  PERFORM test.ok((select status || ':' || audio_ms || ':' || cost_usd || ':' || model from public.ai_requests where id = req) = 'succeeded:3600000:0.1000:stt-async-v6', 'the ledger row now holds the REAL audio duration and cost');
  PERFORM test.ok(public.stt_complete(mA, 'job-1', 'stt-async-v6', hrs, tr) = rev, 'completing the same job again is idempotent');
  PERFORM test.ok((select count(*) from public.meeting_transcripts where meeting_id = mA) = 1, 'and creates no second transcript');
  SELECT * INTO r FROM public.stt_reserve(mA, 120000, 7200000, 36000000);
  PERFORM test.ok(r.outcome = 'already_done', 'a finished meeting is not transcribed (and billed) again');
  PERFORM public.stt_mark_cleaned(mA);
  PERFORM test.ok((select not stt_cleanup_pending from public.meetings where id = mA), 'cleanup flag cleared after the provider data is deleted');
  PERFORM test.act_as(a, 'au-a@example.test');
  PERFORM test.ok((select count(*) from public.ai_requests where feature = 'meeting-transcribe') = 0, 'the ledger of another user is not visible (RLS)');
  PERFORM test.act_as(b, 'au-b@example.test');
  PERFORM test.ok((select count(*) from public.ai_requests where feature = 'meeting-transcribe') = 1, 'the caller sees their own audio usage');

  -- ---- retention / deletion -------------------------------------------------------------------------------------------
  PERFORM test.throws(format('select public.mark_audio_deleted(%L)', mA), '55000', 'audio is not marked deleted while the object still exists');
  IF NOT v_real THEN
    DELETE FROM storage.objects WHERE name = pathA2;
    DELETE FROM storage.objects WHERE name = pathA;
    PERFORM public.mark_audio_deleted(mA);
    PERFORM test.ok((select audio_path IS NULL AND audio_deleted_at IS NOT NULL AND audio_delete_after IS NULL from public.meetings where id = mA), 'after the object is removed the row records the deletion');
    PERFORM public.mark_audio_deleted(mA);
    PERFORM test.ok(true, 'marking deleted twice is idempotent');
    SELECT * INTO r FROM public.stt_reserve(mA, 120000, 7200000, 36000000);
    PERFORM test.ok(r.outcome = 'already_done', 'transcript stays even though the audio is gone');
  ELSE
    PERFORM test.ok(true, 'object deletion path: covered by the real-stack test (real Storage blocks SQL deletes)');
  END IF;
  PERFORM test.ok((select count(*) from public.meeting_transcripts where meeting_id = mA) = 1, 'deleting the audio keeps the transcript');

  -- ---- failures, retries, attempt limit ------------------------------------------------------------------------------
  PERFORM test.reset(); PERFORM test.act_as(b, 'au-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pAu', 'Selhání', 'audio') RETURNING id INTO mC;
  PERFORM public.record_audio_consent(mC);
  pathA := 'pAu/' || mC || '/' || gen_random_uuid() || '.mp3';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pathA, b, '{"size":500,"mimetype":"audio/mpeg"}');
  PERFORM public.attach_meeting_audio(mC, pathA, 500, 'audio/mpeg', 30000);
  FOR n IN 1..3 LOOP
    SELECT * INTO r FROM public.stt_reserve(mC, 30000, 7200000, 36000000);
    PERFORM test.ok(r.outcome = 'started' AND r.attempt = n, format('attempt %s starts', n));
    IF n = 1 THEN
      -- failure before a job exists (the provider refused the request)
      PERFORM public.stt_fail(mC, NULL, 'invalid_audio_file');
      PERFORM test.ok((select stt_state || ':' || stt_error_type || ':' || status || ':' || (not stt_cleanup_pending)::text from public.meetings where id = mC) = 'failed:invalid_audio_file:failed:true', 'failure before a job: type stored, nothing to clean up');
    ELSIF n = 2 THEN
      PERFORM public.stt_attach_job(mC, 'job-x', 'stt-async-v6');
      PERFORM public.stt_fail(mC, 'job-x', 'Provider says: SECRET text!');
      PERFORM test.ok((select stt_error_type from public.meetings where id = mC) = 'unknown', 'a provider message is never stored: anything but a type slug becomes "unknown"');
      PERFORM test.ok((select stt_cleanup_pending from public.meetings where id = mC), 'failure after a job: provider cleanup is pending');
    ELSE
      PERFORM public.stt_attach_job(mC, 'job-y', 'stt-async-v6');
      PERFORM public.stt_fail(mC, 'job-y', 'internal_error');
    END IF;
  END LOOP;
  PERFORM public.stt_fail(mC, 'job-y', 'internal_error');
  PERFORM test.ok(true, 'failing twice is idempotent');
  SELECT * INTO r FROM public.stt_reserve(mC, 30000, 7200000, 36000000);
  PERFORM test.ok(r.outcome = 'attempts_exhausted', 'after 3 attempts no more (paid) retries are possible');
  PERFORM test.ok((select count(*) from public.ai_requests where feature = 'meeting-transcribe' and status = 'failed' and audio_ms = 0 and cost_usd = 0) = 3, 'failed attempts are booked as failed and cost nothing');
  -- a new file resets the attempt budget (and daily budgets still apply)
  pathA2 := 'pAu/' || mC || '/' || gen_random_uuid() || '.mp3';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pathA2, b, '{"size":600,"mimetype":"audio/mpeg"}');
  PERFORM test.ok(public.attach_meeting_audio(mC, pathA2, 600, 'audio/mpeg', 30000) = pathA, 'a replacement file is attached after failures');
  SELECT * INTO r FROM public.stt_reserve(mC, 30000, 7200000, 36000000);
  PERFORM test.ok(r.outcome = 'started' AND r.attempt = 1, 'a new file gets a fresh attempt budget');

  -- ---- stuck submission --------------------------------------------------------------------------------------------
  req2 := r.request_id;
  SELECT * INTO r FROM public.stt_reserve(mC, 30000, 7200000, 36000000);
  PERFORM test.ok(r.outcome = 'in_progress', 'a recent submission without a job id is still in progress');
  PERFORM test.reset();
  UPDATE public.meetings SET stt_submitted_at = now() - interval '11 minutes' WHERE id = mC;
  PERFORM test.act_as(b, 'au-b@example.test');
  SELECT * INTO r FROM public.stt_reserve(mC, 30000, 7200000, 36000000);
  PERFORM test.ok(r.outcome = 'started' AND r.attempt = 2 AND r.request_id <> req2, 'a submission stuck for >10 minutes may be redone (counts as an attempt)');
  PERFORM test.ok((select status || ':' || error_code from public.ai_requests where id = req2) = 'failed:stuck', 'the stuck ledger row is closed as failed');

  -- ---- deleting a meeting cascades -----------------------------------------------------------------------------------
  PERFORM public.stt_attach_job(mC, 'job-z', 'stt-async-v6');
  DELETE FROM public.meetings WHERE id = mC;
  PERFORM test.ok(not exists (select 1 from public.meetings where id = mC), 'a meeting with audio metadata can be deleted (the app removes the object and provider data first)');

  PERFORM test.act_as_anon();
  PERFORM test.throws(format('select * from public.stt_reserve(%L, 60000, 7200000, 36000000)', mA), '42501', 'anon cannot call stt_reserve');
  PERFORM test.throws(format($q$select public.stt_complete(%L, 'j', 'm', 1, '{}'::jsonb)$q$, mA), '42501', 'anon cannot call stt_complete');
END $$;
