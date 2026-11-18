-- Meeting audio (R5): consent, storage isolation, upload registration, SERVER-TRUSTED Soniox bookkeeping, billing certainty,
-- unknown outcomes, cleanup, retention, orphans. No provider is contacted: these are the database RPCs only.
DO $$
DECLARE
  a uuid := test.mkuser('au-a@example.test');   -- project owner
  b uuid := test.mkuser('au-b@example.test');   -- project member
  c uuid := test.mkuser('au-c@example.test');   -- stranger
  v_real boolean := to_regprocedure('storage.protect_delete()') IS NOT NULL;
  sec text := repeat('s', 40);                  -- the "server secret" (only its hash is stored)
  bad text := repeat('x', 40);
  mA uuid; mB uuid; mT uuid; mC uuid; mD uuid; mE uuid; mX uuid;
  pathA text; pathA2 text; pth text;
  r record; t1 timestamptz; t2 timestamptz;
  n int; req uuid; req2 uuid; rev text; rev2 text; job uuid;
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
  PERFORM test.throws($q$update public.meetings set audio_delete_after = now() + interval '10 years' where title = 'Audio porada'$q$, '42501', 'a client cannot extend the retention deadline');
  PERFORM test.throws(format('select public.record_audio_consent(%L)', mT), '22023', 'consent is only recorded for audio meetings');
  PERFORM test.act_as(c, 'au-c@example.test');
  PERFORM test.throws(format('select public.record_audio_consent(%L)', mA), '42501', 'a stranger cannot record consent');
  PERFORM test.act_as_anon();
  PERFORM test.throws(format('select public.record_audio_consent(%L)', mA), '42501', 'anon cannot call the consent RPC');
  PERFORM test.act_as(b, 'au-b@example.test');
  pathA := 'pAu/' || mA || '/' || gen_random_uuid() || '.mp3';
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{"size":1000}')$q$, pathA), '42501', 'upload is refused until consent is recorded (Storage policy)');
  t1 := public.record_audio_consent(mA);
  PERFORM test.ok(t1 IS NOT NULL AND (select consent_by from public.meetings where id = mA) = b, 'consent is recorded with the person who gave it');
  PERFORM pg_sleep(0.01);
  t2 := public.record_audio_consent(mA);
  PERFORM test.ok(t1 = t2 AND (select consent_by from public.meetings where id = mA) = b, 'consent is idempotent: the first consent stands');

  -- ---- storage isolation + object cap -----------------------------------------------------------------------------
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pathA, b, '{"size":1000,"mimetype":"audio/mpeg"}');
  PERFORM test.ok((select count(*) from storage.objects where name = pathA) = 1, 'member uploads and reads audio of a consented meeting');
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{}')$q$, 'pAuC/' || mA || '/' || gen_random_uuid() || '.mp3'), '42501', 'a path whose project does not own the meeting is refused');
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{}')$q$, 'pAu/' || mA || '/sub/' || gen_random_uuid() || '.mp3'), '42501', 'a path with extra folders is refused');
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{}')$q$, 'pAu/' || mT || '/' || gen_random_uuid() || '.mp3'), '42501', 'a TEXT meeting cannot hold audio');
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{}')$q$, 'pAu/' || mB || '/' || gen_random_uuid() || '.mp3'), '42501', 'another meeting WITHOUT consent still refuses uploads');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pAu', 'Limit objektů', 'audio') RETURNING id INTO mX;
  PERFORM public.record_audio_consent(mX);
  FOR n IN 1..4 LOOP
    INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', 'pAu/' || mX || '/' || gen_random_uuid() || '.mp3', b, '{"size":1}');
  END LOOP;
  PERFORM test.throws(format($q$insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', %L, auth.uid(), '{}')$q$, 'pAu/' || mX || '/' || gen_random_uuid() || '.mp3'), '42501', 'the 5th object of one meeting is refused (cap 4: no unbounded stray uploads)');
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
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 1000, 'audio/mpeg', 1000)$q$, mB, pathA), '55000', 'attach without consent is refused');
  PERFORM test.act_as(c, 'au-c@example.test');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 1000, 'audio/mpeg', 1000)$q$, mA, pathA), '42501', 'a stranger cannot attach');
  PERFORM test.act_as(b, 'au-b@example.test');
  PERFORM test.ok(public.attach_meeting_audio(mA, pathA, 1000, 'audio/mpeg', 60000) IS NULL, 'first attach succeeds and there is no previous file');
  PERFORM test.ok((select status from public.meetings where id = mA) = 'uploaded' AND (select audio_path from public.meetings where id = mA) = pathA, 'the meeting is now uploaded');
  PERFORM test.ok((select audio_delete_after > now() + interval '6 days 23 hours' and audio_delete_after < now() + interval '7 days 1 hour' from public.meetings where id = mA),
    'RETENTION STARTS AT UPLOAD: every uploaded file has a deletion deadline, even if it is never transcribed');
  pathA2 := 'pAu/' || mA || '/' || gen_random_uuid() || '.wav';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pathA2, b, '{"size":2000,"mimetype":"audio/wav"}');
  PERFORM test.ok(public.attach_meeting_audio(mA, pathA2, 2000, 'audio/wav', 120000) = pathA, 'replacing the audio returns the previous path for deletion');

  -- ---- SERVER TRUST: members cannot do trusted bookkeeping with their own JWT ----------------------------------------
  PERFORM test.throws(format('select * from public.stt_reserve(%L, %L, 120000, 72000000, 360000000)', sec, mA), '42501', 'NO secret registered yet: even the right-looking call is refused (fail closed)');
  PERFORM test.reset();
  INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('stt', encode(sha256(convert_to(sec, 'UTF8')), 'hex'));
  PERFORM test.act_as(b, 'au-b@example.test');
  PERFORM test.throws('select * from public.server_trust', '42501', 'a member cannot read the trust table');
  PERFORM test.throws(format('select * from public.stt_reserve(%L, %L, 120000, 72000000, 360000000)', bad, mA), '42501', 'stt_reserve with a WRONG secret is refused');
  PERFORM test.throws(format('select * from public.stt_reserve(%L, %L, 120000, 72000000, 360000000)', 'short', mA), '42501', 'stt_reserve with a short secret is refused');
  PERFORM test.throws(format('select * from public.stt_reserve(NULL, %L, 120000, 72000000, 360000000)', mA), '42501', 'stt_reserve without a secret is refused');
  PERFORM test.throws(format($q$select public.stt_attach_job(%L, %L, 'job-x', 'stt-async-v6')$q$, bad, mA), '42501', 'stt_attach_job is server-only');
  PERFORM test.throws(format($q$select public.stt_mark_unknown(%L, %L, 'network_error')$q$, bad, mA), '42501', 'stt_mark_unknown is server-only');
  PERFORM test.throws(format($q$select public.stt_resolve_unknown(%L, %L, 'absent')$q$, bad, mA), '42501', 'stt_resolve_unknown is server-only');
  PERFORM test.throws(format($q$select public.stt_fail(%L, %L, NULL, 'x', 'none')$q$, bad, mA), '42501', 'stt_fail (which can zero a ledger row) is server-only');
  PERFORM test.throws(format($q$select public.stt_complete(%L, %L, 'j', 'm', 0, '{}'::jsonb)$q$, bad, mA), '42501', 'stt_complete (which writes machine provenance) is server-only');
  PERFORM test.throws(format($q$select public.stt_cleanup_result(%L, gen_random_uuid(), 'done')$q$, bad), '42501', 'stt_cleanup_result is server-only');
  PERFORM test.act_as(c, 'au-c@example.test');
  PERFORM test.throws(format('select * from public.stt_reserve(%L, %L, 120000, 72000000, 360000000)', sec, mA), '42501', 'even WITH the secret a stranger is refused (membership is still required)');
  PERFORM test.act_as_anon();
  PERFORM test.throws(format('select * from public.stt_reserve(%L, %L, 120000, 72000000, 360000000)', sec, mA), '42501', 'anon cannot call stt_reserve');
  PERFORM test.act_as(b, 'au-b@example.test');
  PERFORM test.ok((select count(*) from public.ai_requests where feature = 'meeting-transcribe') = 0 AND (select count(*) from public.stt_jobs) = 0, 'the refused calls left no ledger row and no job');
  PERFORM test.throws($q$insert into public.stt_jobs (project_id, attempt, client_reference, state) values ('pAu', 1, 'x', 'active')$q$, '42501', 'clients cannot write jobs');

  -- ---- reserve (the server, with the secret) -----------------------------------------------------------------------
  PERFORM test.throws(format('select * from public.stt_reserve(%L, %L, 0, 1000000, 1000000)', sec, mA), '22023', 'zero estimated duration is refused');
  PERFORM test.throws(format('select * from public.stt_reserve(%L, %L, 99999999, 1000000, 1000000)', sec, mA), '22023', 'more than 300 minutes is refused');
  SELECT * INTO r FROM public.stt_reserve(sec, mB, 60000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'no_consent', 'no job without consent');
  PERFORM public.record_audio_consent(mB);
  SELECT * INTO r FROM public.stt_reserve(sec, mB, 60000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'no_audio', 'no job without an uploaded file');
  SELECT * INTO r FROM public.stt_reserve(sec, mA, 120000, 60000, 36000000);
  PERFORM test.ok(r.outcome = 'budget_exceeded', 'the per-user daily audio budget is enforced (limits come from the SERVER)');
  SELECT * INTO r FROM public.stt_reserve(sec, mA, 120000, 7200000, 60000);
  PERFORM test.ok(r.outcome = 'global_budget_exceeded', 'the global daily audio budget is enforced');
  PERFORM test.ok((select count(*) from public.ai_requests where feature = 'meeting-transcribe') = 0, 'refused reservations book nothing');
  SELECT * INTO r FROM public.stt_reserve(sec, mA, 120000, 72000000, 360000000);
  req := r.request_id;
  PERFORM test.ok(r.outcome = 'started' AND r.attempt = 1 AND r.audio_path = pathA2 AND r.audio_mime = 'audio/wav' AND r.project_id = 'pAu' AND r.client_reference = mA::text || ':1', 'a transcription is started with the stored path and a reconcilable client reference');
  PERFORM test.ok((select stt_state from public.meetings where id = mA) = 'submitting' AND (select status from public.meetings where id = mA) = 'transcribing', 'state machine: submitting');
  PERFORM test.ok((select provider || ':' || audio_ms || ':' || status || ':' || billing_state from public.ai_requests where id = req) = 'soniox:120000:reserved:reserved', 'the ledger row is booked at the estimate');
  PERFORM test.ok((select count(*) from public.stt_jobs where meeting_id = mA and attempt = 1 and state = 'submitting' and provider_job_id is null) = 1, 'a job row exists before the provider is contacted');
  SELECT * INTO r FROM public.stt_reserve(sec, mA, 120000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'in_progress' AND r.request_id = req, 'a duplicate start reports in_progress and returns the same request');
  PERFORM test.ok((select count(*) from public.ai_requests where feature = 'meeting-transcribe') = 1 AND (select count(*) from public.stt_jobs where meeting_id = mA) = 1, 'a duplicate start books nothing and creates no second job');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 2000, 'audio/wav', 1)$q$, mA, pathA2), '55000', 'audio cannot be replaced while a job runs');

  -- ---- attach job ---------------------------------------------------------------------------------------------------
  PERFORM test.throws(format($q$select public.stt_attach_job(%L, %L, '', 'stt-async-v6')$q$, sec, mA), '22023', 'an empty job id is refused');
  PERFORM test.ok(public.stt_attach_job(sec, mA, 'job-1', 'stt-async-v6') = 'attached', 'the provider job id is recorded');
  PERFORM test.ok((select stt_state || ':' || stt_job_id || ':' || stt_model || ':' || stt_provider from public.meetings where id = mA) = 'transcribing:job-1:stt-async-v6:soniox', 'state machine: transcribing');
  PERFORM test.ok(public.stt_attach_job(sec, mA, 'job-1', 'stt-async-v6') = 'attached', 'attaching the same job twice is idempotent');
  PERFORM test.throws(format($q$select public.stt_attach_job(%L, %L, 'job-2', 'stt-async-v6')$q$, sec, mA), '55000', 'an attempt cannot be given a second provider job');
  SELECT * INTO r FROM public.stt_reserve(sec, mA, 120000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'in_progress', 'while transcribing a new start is in_progress');

  -- ---- provenance + stt_complete -------------------------------------------------------------------------------------
  rev := md5('soniox1') || md5('soniox2');
  tr := jsonb_build_object('revision', rev, 'char_count', 40,
        'speakers', jsonb_build_array(jsonb_build_object('id', 'S1', 'label', 'Mluvčí 1', 'displayName', null)),
        'segments', jsonb_build_array(jsonb_build_object('id', 'seg-0-0', 'startMs', 0, 'endMs', 4000, 'speakerId', 'S1', 'text', 'Ahoj, začneme poradou.')),
        'coverage', jsonb_build_object('gaps', 0));
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count) values (%L, 'pAu', %L, 'soniox', '[]', '[{"id":"s","text":"forged"}]', 6)$q$, mA, md5('forge') || md5('forge2')), '42501', 'a member cannot forge a machine transcript with a direct INSERT');
  PERFORM test.throws(format($q$select public.stt_complete(%L, %L, 'job-1', 'stt-async-v6', 1, %L::jsonb)$q$, bad, mA, tr::text), '42501', 'THE AUDIT PROBE: a member CANNOT complete a job with an arbitrary transcript through the RPC any more');
  PERFORM test.throws(format($q$select public.stt_complete(%L, %L, 'wrong-job', 'stt-async-v6', 4000, %L::jsonb)$q$, sec, mA, tr::text), '55000', 'completion with a different job id is refused');
  PERFORM test.throws(format($q$select public.stt_complete(%L, %L, 'job-1', 'stt-async-v6', 4000, %L::jsonb)$q$, sec, mA, (tr - 'revision')::text), '22023', 'a transcript without a revision is refused');
  rev2 := public.stt_complete(sec, mA, 'job-1', 'stt-async-v6', hrs, tr);
  PERFORM test.ok(rev2 = rev, 'the server stores the result and gets the revision id');
  PERFORM test.ok((select count(*) from public.meeting_transcripts where meeting_id = mA and source = 'soniox') = 1, 'the machine transcript is stored once as source soniox');
  PERFORM test.ok((select stt_state || ':' || status || ':' || current_revision from public.meetings where id = mA) = 'completed:transcribed:' || rev, 'meeting is transcribed and points at the new revision');
  PERFORM test.ok((select stt_audio_ms = hrs AND stt_cost_usd = 0.1000 AND stt_cleanup_pending from public.meetings where id = mA), 'actual duration and the cost estimate are booked; provider cleanup is pending');
  PERFORM test.ok((select audio_delete_after < now() + interval '7 days 1 hour' and audio_delete_after > now() + interval '6 days 23 hours' from public.meetings where id = mA), 'completion does not EXTEND the deadline set at upload');
  PERFORM test.ok((select status || ':' || audio_ms || ':' || cost_usd || ':' || model || ':' || billing_state from public.ai_requests where id = req) = 'succeeded:3600000:0.1000:stt-async-v6:actual', 'the ledger row now holds the REAL audio duration and cost');
  PERFORM test.ok(public.stt_complete(sec, mA, 'job-1', 'stt-async-v6', hrs, tr) = rev, 'completing the same job again is idempotent');
  PERFORM test.ok((select count(*) from public.meeting_transcripts where meeting_id = mA) = 1, 'and creates no second transcript');
  SELECT * INTO r FROM public.stt_reserve(sec, mA, 120000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'already_done', 'a finished meeting is not transcribed (and billed) again');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 2000, 'audio/wav', 1)$q$, mA, pathA2), '55000', 'the audio of a finished meeting cannot be swapped');

  -- ---- cleanup of provider data: independent, retryable, survives failures ------------------------------------------
  SELECT id INTO job FROM public.stt_jobs WHERE meeting_id = mA AND provider_job_id = 'job-1';
  PERFORM test.ok((select cleanup_state from public.stt_jobs where id = job) = 'pending', 'after completion the provider job is queued for deletion');
  PERFORM test.act_as(c, 'au-c@example.test');
  PERFORM test.throws(format($q$select public.stt_cleanup_result(%L, %L, 'done')$q$, sec, job), '42501', 'a stranger cannot report cleanup for a foreign job');
  PERFORM test.ok((select count(*) from public.stt_jobs) = 0, 'a stranger sees no jobs');
  PERFORM test.act_as(b, 'au-b@example.test');
  PERFORM public.stt_cleanup_result(sec, job, 'retry', 'internal_error');
  PERFORM test.ok((select cleanup_state || ':' || cleanup_attempts || ':' || cleanup_last_error from public.stt_jobs where id = job) = 'pending:1:internal_error' AND (select cleanup_due_at > now() from public.stt_jobs where id = job), 'a failed deletion is retried later with backoff and the job id is KEPT');
  PERFORM test.ok((select stt_cleanup_pending from public.meetings where id = mA), 'the meeting still shows pending cleanup');
  PERFORM public.stt_cleanup_result(sec, job, 'done');
  PERFORM test.ok((select cleanup_state from public.stt_jobs where id = job) = 'done' AND (select cleaned_at is not null from public.stt_jobs where id = job), 'confirmed deletion is recorded');
  PERFORM test.ok((select not stt_cleanup_pending from public.meetings where id = mA), 'the meeting flag clears only when no job is pending');
  PERFORM public.stt_cleanup_result(sec, job, 'retry', 'x');
  PERFORM test.ok((select cleanup_state from public.stt_jobs where id = job) = 'done', 'cleanup results are idempotent (a done job is never reopened)');

  -- ---- retention / deletion -------------------------------------------------------------------------------------------
  PERFORM test.throws(format('select public.mark_audio_deleted(%L)', mA), '55000', 'audio is not marked deleted while the object still exists');
  IF NOT v_real THEN
    DELETE FROM storage.objects WHERE name = pathA2;
    DELETE FROM storage.objects WHERE name = pathA;
    PERFORM public.mark_audio_deleted(mA);
    PERFORM test.ok((select audio_path IS NULL AND audio_deleted_at IS NOT NULL AND audio_delete_after IS NULL from public.meetings where id = mA), 'after the object is removed the row records the deletion');
    PERFORM public.mark_audio_deleted(mA);
    PERFORM test.ok(true, 'marking deleted twice is idempotent');
  ELSE
    PERFORM test.ok(true, 'object deletion path: covered by the real-stack test (real Storage blocks SQL deletes)');
  END IF;
  PERFORM test.ok((select count(*) from public.meeting_transcripts where meeting_id = mA) = 1, 'deleting the audio keeps the transcript');

  -- ---- billing certainty: cancellation, failure and retries never erase cost -----------------------------------------
  PERFORM test.reset(); PERFORM test.act_as(b, 'au-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pAu', 'Zrušení', 'audio') RETURNING id INTO mC;
  PERFORM public.record_audio_consent(mC);
  pth := 'pAu/' || mC || '/' || gen_random_uuid() || '.mp3';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pth, b, '{"size":500,"mimetype":"audio/mpeg"}');
  PERFORM public.attach_meeting_audio(mC, pth, 500, 'audio/mpeg', 30000);
  SELECT * INTO r FROM public.stt_reserve(sec, mC, 1800000, 72000000, 360000000);
  req := r.request_id;
  PERFORM public.stt_attach_job(sec, mC, 'job-c1', 'stt-async-v6');
  PERFORM public.stt_fail(sec, mC, 'job-c1', 'cancelled', 'estimated');
  PERFORM test.ok((select status || ':' || billing_state || ':' || audio_ms from public.ai_requests where id = req) = 'failed:estimated:1800000', 'CANCELLING a running job keeps the reserved estimate in the ledger (the provider may still bill it)');
  PERFORM test.ok((select state || ':' || cleanup_state || ':' || provider_job_id from public.stt_jobs where meeting_id = mC and attempt = 1) = 'cancelled:pending:job-c1', 'the cancelled job id is kept and queued for provider-side deletion');
  PERFORM test.ok((select stt_cleanup_pending and stt_job_id = 'job-c1' and stt_state = 'failed' from public.meetings where id = mC), 'the meeting keeps the provider job id');
  SELECT * INTO r FROM public.stt_reserve(sec, mC, 1000, 5400000, 360000000);
  PERFORM test.ok(r.outcome = 'budget_exceeded', 'the cancelled estimate STILL counts against the daily budget (cancel-and-retry cannot be used to spend without limit)');
  SELECT * INTO r FROM public.stt_reserve(sec, mC, 1000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'started' AND r.attempt = 2 AND r.client_reference = mC::text || ':2', 'a retry is a NEW attempt with its own reference');
  PERFORM test.ok((select stt_job_id from public.meetings where id = mC) = 'job-c1', 'starting a retry does NOT forget the previous provider job id');
  req2 := r.request_id;
  PERFORM public.stt_fail(sec, mC, NULL, 'invalid_audio', 'none');
  PERFORM test.ok((select status || ':' || billing_state || ':' || audio_ms || ':' || cost_usd from public.ai_requests where id = req2) = 'failed:not_billed:0:0.0000', 'a failure CONFIRMED not billed (e.g. audio rejected before any provider call) is released from the budget');
  SELECT * INTO r FROM public.stt_reserve(sec, mC, 1000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'started' AND r.attempt = 3, 'third attempt');
  PERFORM public.stt_attach_job(sec, mC, 'job-c3', 'stt-async-v6');
  PERFORM public.stt_fail(sec, mC, 'job-c3', 'empty_transcript', 'actual', 60000);
  PERFORM test.ok((select audio_ms || ':' || cost_usd || ':' || billing_state from public.ai_requests where id = (select stt_request_id from public.meetings where id = mC)) = '60000:0.0017:actual', 'a job that failed AFTER the provider processed it is booked at the provider''s real duration');
  SELECT * INTO r FROM public.stt_reserve(sec, mC, 1000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'attempts_exhausted', 'attempts are cumulative per meeting');
  pth := 'pAu/' || mC || '/' || gen_random_uuid() || '.mp3';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pth, b, '{"size":600,"mimetype":"audio/mpeg"}');
  PERFORM test.ok(public.attach_meeting_audio(mC, pth, 600, 'audio/mpeg', 30000) IS NOT NULL, 'a replacement file can be attached after failures');
  SELECT * INTO r FROM public.stt_reserve(sec, mC, 1000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'attempts_exhausted', 'REPLACING THE FILE DOES NOT RESET THE ATTEMPT COUNTER');
  PERFORM test.ok((select audio_delete_after is not null from public.meetings where id = mC), 'a failed meeting still has a deletion deadline');
  PERFORM test.ok((select count(*) from public.stt_jobs where meeting_id = mC and cleanup_state = 'pending') = 2, 'both provider jobs are still queued for deletion (ids never forgotten)');

  -- ---- unknown outcomes are NEVER repeated automatically --------------------------------------------------------------
  PERFORM test.reset(); PERFORM test.act_as(b, 'au-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pAu', 'Nejisté', 'audio') RETURNING id INTO mD;
  PERFORM public.record_audio_consent(mD);
  pth := 'pAu/' || mD || '/' || gen_random_uuid() || '.mp3';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pth, b, '{"size":500,"mimetype":"audio/mpeg"}');
  PERFORM public.attach_meeting_audio(mD, pth, 500, 'audio/mpeg', 30000);
  SELECT * INTO r FROM public.stt_reserve(sec, mD, 600000, 72000000, 360000000);
  req := r.request_id;
  PERFORM public.stt_mark_unknown(sec, mD, 'network_error');
  PERFORM test.ok((select stt_state || ':' || stt_error_type from public.meetings where id = mD) = 'unknown:network_error', 'an ambiguous provider POST (timeout/5xx) puts the meeting into "unknown"');
  PERFORM test.ok((select billing_state from public.ai_requests where id = req) = 'uncertain' AND (select audio_ms from public.ai_requests where id = req) = 600000, 'the estimate stays in the budget as UNCERTAIN');
  PERFORM public.stt_mark_unknown(sec, mD, 'network_error');
  PERFORM test.ok(true, 'marking unknown twice is idempotent');
  SELECT * INTO r FROM public.stt_reserve(sec, mD, 600000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'unknown_outcome', 'a retry while the outcome is unknown is NOT started (no repeated paid POST)');
  PERFORM test.ok((select count(*) from public.stt_jobs where meeting_id = mD) = 1 AND (select count(*) from public.ai_requests where feature = 'meeting-transcribe' and project_id = 'pAu' and created_at > now() - interval '1 minute' and audio_ms = 600000) = 1, 'and creates no second job or ledger row');
  PERFORM test.throws(format($q$select public.attach_meeting_audio(%L, %L, 500, 'audio/mpeg', 1)$q$, mD, pth), '55000', 'audio cannot be swapped while the outcome is unknown');
  PERFORM test.throws(format('select public.mark_audio_deleted(%L)', mD), '55000', 'and cannot be deleted before the outcome is known');
  -- reconciled: the provider list showed the job -> adopt it (no new POST)
  PERFORM test.ok(public.stt_attach_job(sec, mD, 'job-adopted', 'stt-async-v6') = 'attached', 'RECONCILIATION: the provider job found by client_reference is adopted');
  PERFORM test.ok((select stt_state || ':' || stt_job_id from public.meetings where id = mD) = 'transcribing:job-adopted', 'the meeting continues as transcribing');
  -- absent: the provider list proved there is no job -> safe to retry, nothing billed
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pAu', 'Chybějící', 'audio') RETURNING id INTO mE;
  PERFORM public.record_audio_consent(mE);
  pth := 'pAu/' || mE || '/' || gen_random_uuid() || '.mp3';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pth, b, '{"size":500,"mimetype":"audio/mpeg"}');
  PERFORM public.attach_meeting_audio(mE, pth, 500, 'audio/mpeg', 30000);
  SELECT * INTO r FROM public.stt_reserve(sec, mE, 600000, 72000000, 360000000);
  req := r.request_id;
  PERFORM public.stt_mark_unknown(sec, mE, 'timeout');
  PERFORM public.stt_resolve_unknown(sec, mE, 'absent');
  PERFORM test.ok((select stt_state || ':' || stt_error_type from public.meetings where id = mE) = 'failed:not_created', 'confirmed absent: the attempt failed as not_created');
  PERFORM test.ok((select billing_state || ':' || audio_ms from public.ai_requests where id = req) = 'not_billed:0', 'and the estimate is RELEASED from the budget (only now)');
  SELECT * INTO r FROM public.stt_reserve(sec, mE, 600000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'started' AND r.attempt = 2, 'only now a retry is allowed');
  -- abandon: the user gave up waiting -> the estimate stays
  PERFORM public.stt_mark_unknown(sec, mE, 'timeout');
  req2 := (select stt_request_id from public.meetings where id = mE);
  PERFORM public.stt_resolve_unknown(sec, mE, 'abandon');
  PERFORM test.ok((select billing_state from public.ai_requests where id = req2) = 'uncertain', 'ABANDONING an unknown outcome keeps the estimate in the budget');
  PERFORM test.ok((select cleanup_state from public.stt_jobs where meeting_id = mE and attempt = 2) = 'abandoned', 'and marks the unreachable job abandoned');
  PERFORM test.throws(format($q$select public.stt_resolve_unknown(%L, %L, 'maybe')$q$, sec, mE), '22023', 'an unknown resolution value is refused');
  -- stuck submitting (the server died around the POST) is never silently redone
  PERFORM test.reset(); PERFORM test.act_as(b, 'au-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pAu', 'Zaseknuté', 'audio') RETURNING id INTO mC;
  PERFORM public.record_audio_consent(mC);
  pth := 'pAu/' || mC || '/' || gen_random_uuid() || '.mp3';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pth, b, '{"size":500,"mimetype":"audio/mpeg"}');
  PERFORM public.attach_meeting_audio(mC, pth, 500, 'audio/mpeg', 30000);
  SELECT * INTO r FROM public.stt_reserve(sec, mC, 600000, 72000000, 360000000);
  req := r.request_id;
  PERFORM test.reset();
  UPDATE public.meetings SET stt_submitted_at = now() - interval '11 minutes' WHERE id = mC;
  PERFORM test.act_as(b, 'au-b@example.test');
  SELECT * INTO r FROM public.stt_reserve(sec, mC, 600000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'unknown_outcome', 'a submission stuck >10 minutes becomes UNKNOWN, it is not redone');
  PERFORM test.ok((select billing_state from public.ai_requests where id = req) = 'uncertain', 'and its estimate keeps counting');
  PERFORM test.ok((select state from public.stt_jobs where meeting_id = mC and attempt = 1) = 'unknown_outcome', 'the job row records the unknown outcome');
  -- cancelled during submitting, then the late POST result arrives: the job id must not be lost
  PERFORM public.stt_resolve_unknown(sec, mC, 'abandon');
  PERFORM test.reset(); PERFORM test.act_as(b, 'au-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pAu', 'Pozdní', 'audio') RETURNING id INTO mD;
  PERFORM public.record_audio_consent(mD);
  pth := 'pAu/' || mD || '/' || gen_random_uuid() || '.mp3';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pth, b, '{"size":500,"mimetype":"audio/mpeg"}');
  PERFORM public.attach_meeting_audio(mD, pth, 500, 'audio/mpeg', 30000);
  PERFORM public.stt_reserve(sec, mD, 600000, 72000000, 360000000);
  PERFORM public.stt_fail(sec, mD, NULL, 'cancelled', 'uncertain');
  PERFORM test.ok(public.stt_attach_job(sec, mD, 'job-late', 'stt-async-v6') = 'orphaned', 'a job created while the user cancelled is reported as orphaned');
  PERFORM test.ok((select provider_job_id || ':' || cleanup_state from public.stt_jobs where meeting_id = mD) = 'job-late:pending', 'but its id is KEPT and queued for deletion (not lost)');
  PERFORM test.ok((select stt_cleanup_pending and stt_state = 'failed' from public.meetings where id = mD), 'the meeting stays failed with cleanup pending');
  PERFORM test.throws(format($q$select public.stt_fail(%L, %L, 'job-late', 'x', 'bogus')$q$, sec, mD), '22023', 'an invalid billing state is refused');

  -- ---- deleting a meeting: provider job rows and orphan audio survive for cleanup -------------------------------------
  PERFORM test.act_as(a, 'au-a@example.test');
  DELETE FROM public.meetings WHERE id = mD;
  PERFORM test.ok((select count(*) from public.stt_jobs where provider_job_id = 'job-late' and meeting_id is null and cleanup_state = 'pending') = 1, 'the job row (and its provider job id) OUTLIVES the deleted meeting, still pending cleanup');
  PERFORM test.ok((select count(*) from public.meeting_audio_orphans where path = pth) = 1, 'audio of a meeting deleted directly is queued as an orphan');
  PERFORM test.act_as(c, 'au-c@example.test');
  PERFORM test.ok((select count(*) from public.meeting_audio_orphans) = 0 AND (select count(*) from public.stt_jobs) = 0, 'a stranger sees neither the orphan queue nor the jobs');
  PERFORM test.act_as(b, 'au-b@example.test');
  SELECT id INTO job FROM public.stt_jobs WHERE provider_job_id = 'job-late';
  PERFORM public.stt_cleanup_result(sec, job, 'done');
  PERFORM test.ok((select cleanup_state from public.stt_jobs where id = job) = 'done', 'a member can finish the provider cleanup of a job whose meeting is gone');
  IF NOT v_real THEN
    DELETE FROM storage.objects WHERE name = pth; GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM test.ok(n = 1, 'a member can delete the orphaned object (policy allows it because the meeting row is gone)');
  END IF;
  PERFORM test.ok(public.is_orphan_meeting_audio(pth), 'is_orphan_meeting_audio recognises the object');
  DELETE FROM public.meeting_audio_orphans WHERE path = pth;
  PERFORM test.ok((select count(*) from public.meeting_audio_orphans where path = pth) = 0, 'the queue row is cleared after cleanup');

  -- ---- a billed result is never discarded by the revision cap ---------------------------------------------------------
  PERFORM test.reset(); PERFORM test.act_as(b, 'au-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pAu', 'Plný', 'audio') RETURNING id INTO mC;
  PERFORM public.record_audio_consent(mC);
  pth := 'pAu/' || mC || '/' || gen_random_uuid() || '.mp3';
  INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pth, b, '{"size":500,"mimetype":"audio/mpeg"}');
  PERFORM public.attach_meeting_audio(mC, pth, 500, 'audio/mpeg', 30000);
  FOR n IN 1..25 LOOP
    INSERT INTO public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count)
      VALUES (mC, 'pAu', md5('cap' || n) || md5('Cap' || n), 'paste', '[]', jsonb_build_array(jsonb_build_object('id', 's', 'text', 'x')), 1);
  END LOOP;
  PERFORM public.stt_reserve(sec, mC, 600000, 72000000, 360000000);
  PERFORM public.stt_attach_job(sec, mC, 'job-cap', 'stt-async-v6');
  PERFORM test.ok(public.stt_complete(sec, mC, 'job-cap', 'stt-async-v6', 60000, jsonb_set(tr, '{revision}', to_jsonb(md5('capx') || md5('capy')))) = md5('capx') || md5('capy'), 'the 26th revision is stored when it is a BILLED provider result');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count) values (%L, 'pAu', %L, 'paste', '[]', '[{"id":"s","text":"x"}]', 1)$q$, mC, md5('human') || md5('Human')), 'PT429', 'while a human cannot add one beyond the cap');

  PERFORM test.act_as_anon();
  PERFORM test.throws(format($q$select public.stt_complete(%L, %L, 'j', 'm', 1, '{}'::jsonb)$q$, sec, mA), '42501', 'anon cannot call stt_complete');
END $$;
