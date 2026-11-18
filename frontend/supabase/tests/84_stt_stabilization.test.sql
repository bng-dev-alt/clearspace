-- Stabilization of the STT bookkeeping (final review of 3c25e9c): obsolete overloads gone, jobs bound to their ORIGINAL attempt,
-- cancel during submitting cannot be followed by an immediate paid retry, forged machine provenance impossible from SQL,
-- unattached uploads listed for the sweep. Database level only (no provider is contacted).
DO $$
DECLARE
  a uuid := test.mkuser('st-a@example.test');   -- project owner
  b uuid := test.mkuser('st-b@example.test');   -- project member
  c uuid := test.mkuser('st-c@example.test');   -- stranger
  sec text := repeat('s', 40);
  m uuid; m2 uuid; pth text; r record; req1 uuid; n int; res text; tr jsonb;
BEGIN
  PERFORM test.act_as(a, 'st-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pSt', 'Stabilization');
  PERFORM test.reset();
  INSERT INTO public.project_members (project_id, member_id) SELECT 'pSt', id FROM public.workspace_members WHERE profile_id = b;

  -- ---- F1: only attempt-bound, secret-first STT functions exist --------------------------------------------------------
  PERFORM test.ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'stt\_%' ESCAPE '\'
       AND (p.proargnames IS NULL OR p.proargnames[1] IS DISTINCT FROM 'p_server_secret')),
    'F1: every public.stt_* function takes p_server_secret FIRST (no obsolete secret-less overload is left)');
  PERFORM test.ok(to_regprocedure('public.stt_reserve(uuid,integer,bigint,bigint)') IS NULL AND to_regprocedure('public.stt_attach_job(uuid,text,text)') IS NULL
                  AND to_regprocedure('public.stt_fail(uuid,text,text)') IS NULL AND to_regprocedure('public.stt_complete(uuid,text,text,integer,jsonb,integer)') IS NULL
                  AND to_regprocedure('public.stt_mark_cleaned(uuid)') IS NULL AND to_regprocedure('public.stt_attach_job(text,uuid,text,text)') IS NULL
                  AND to_regprocedure('public.stt_mark_unknown(text,uuid,text)') IS NULL AND to_regprocedure('public.stt_fail(text,uuid,text,text,text,integer)') IS NULL,
    'F1: the named obsolete signatures do not exist');
  PERFORM test.ok(NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND (p.proname LIKE 'stt\_%' ESCAPE '\' OR p.proname IN ('require_server_secret', 'lock_meeting_for_member'))
       AND (has_function_privilege('anon', p.oid, 'execute') OR has_function_privilege('public', p.oid, 'execute'))),
    'F1: no STT function is executable by anon or PUBLIC');
  PERFORM test.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('require_server_secret', 'lock_meeting_for_member') AND has_function_privilege('authenticated', p.oid, 'execute')),
    'F1: require_server_secret and lock_meeting_for_member are not callable by members');

  PERFORM test.reset();
  INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('stt', encode(sha256(convert_to(sec, 'UTF8')), 'hex')) ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;
  -- fixture: an audio meeting with an attached file
  PERFORM test.act_as(b, 'st-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pSt', 'Stabilizace', 'audio') RETURNING id INTO m;
  PERFORM public.record_audio_consent(m);
  pth := 'pSt/' || m || '/' || gen_random_uuid() || '.mp3';
  PERFORM test.reset(); INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pth, b, '{"size":500,"mimetype":"audio/mpeg"}'); PERFORM test.act_as(b, 'st-b@example.test');
  PERFORM public.attach_meeting_audio(m, pth, 500, 'audio/mpeg', 30000);

  -- ---- F3: a late job id binds to ITS attempt, never to a newer one -----------------------------------------------------
  SELECT * INTO r FROM public.stt_reserve(sec, m, 600000, 72000000, 360000000);
  req1 := r.request_id;
  PERFORM test.ok(r.attempt = 1 AND r.client_reference = m::text || ':1', 'F3: attempt 1 started');
  -- the user cancels while the POST is in flight: the application marks the outcome UNKNOWN (not failed)
  PERFORM public.stt_mark_unknown(sec, m, 1, 'cancel_requested');
  SELECT * INTO r FROM public.stt_reserve(sec, m, 600000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'unknown_outcome', 'F3: no immediate retry after a cancel during submitting (no second paid POST)');
  PERFORM test.ok((SELECT count(*) FROM public.stt_jobs WHERE meeting_id = m) = 1, 'F3: still exactly one job row');
  PERFORM test.ok(public.stt_resolve_unknown(sec, m, 'abandon') = 'too_early', 'F3: and the user cannot abandon it inside the submission window');
  -- the in-flight POST completes: its id is adopted by ITS attempt
  PERFORM test.ok(public.stt_attach_job(sec, m, 1, 'job-1', 'stt-async-v6') = 'attached', 'F3: the late job id is attached to attempt 1');
  PERFORM test.ok((SELECT stt_state || ':' || stt_job_id FROM public.meetings WHERE id = m) = 'transcribing:job-1', 'F3: the meeting follows the real job');
  -- user cancels the (now known) running job: cost kept, id kept, a retry is then allowed
  PERFORM public.stt_fail(sec, m, 1, 'job-1', 'cancelled', 'estimated');
  SELECT * INTO r FROM public.stt_reserve(sec, m, 600000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'started' AND r.attempt = 2, 'F3: after cancelling a KNOWN job a retry is a new attempt');
  -- a stale attach for attempt 1 can never take over attempt 2
  PERFORM test.ok(public.stt_attach_job(sec, m, 1, 'job-1', 'stt-async-v6') = 'orphaned', 'F3: a repeated/stale attach for attempt 1 reports orphaned');
  PERFORM test.ok((SELECT stt_state || ':' || coalesce(stt_job_id, '-') FROM public.meetings WHERE id = m) = 'submitting:job-1', 'F3: attempt 2 is untouched by it (still submitting; stt_job_id keeps the old id for cleanup)');
  PERFORM test.ok(public.stt_attach_job(sec, m, 2, 'job-2', 'stt-async-v6') = 'attached', 'F3: attempt 2 gets ITS OWN job id');
  PERFORM test.ok((SELECT string_agg(attempt || ':' || provider_job_id, ' ' ORDER BY attempt) FROM public.stt_jobs WHERE meeting_id = m) = '1:job-1 2:job-2', 'F3: both provider job ids are recorded, none lost');
  -- stale failure/unknown calls for an older attempt change nothing
  PERFORM public.stt_fail(sec, m, 1, 'job-1', 'x', 'none');
  PERFORM public.stt_mark_unknown(sec, m, 1, 'x');
  PERFORM test.ok((SELECT stt_state FROM public.meetings WHERE id = m) = 'transcribing', 'F3: stale stt_fail / stt_mark_unknown for attempt 1 do not touch attempt 2');
  PERFORM test.ok((SELECT billing_state FROM public.ai_requests WHERE id = req1) = 'estimated', 'F3: attempt 1 keeps its booked cost');
  -- an attach for an attempt that does not exist
  PERFORM test.throws(format($q$select public.stt_attach_job(%L, %L, 9, 'job-9', 'm')$q$, sec, m), '55000', 'F3: attaching to a non-existent attempt is refused');
  -- cancel of the abandoned-then-late case: the id is kept for cleanup
  PERFORM public.stt_fail(sec, m, 2, 'job-2', 'cancelled', 'estimated');
  PERFORM test.ok((SELECT count(*) FROM public.stt_jobs WHERE meeting_id = m AND cleanup_state = 'pending') = 2, 'F3: both provider jobs queued for deletion');

  -- ---- F3 at database level: a direct stt_fail on a SUBMITTING attempt that is not a CONFIRMED rejection leaves it UNKNOWN ---------
  PERFORM test.act_as(b, 'st-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pSt', 'Přímé selhání', 'audio') RETURNING id INTO m2;
  PERFORM public.record_audio_consent(m2);
  pth := 'pSt/' || m2 || '/' || gen_random_uuid() || '.mp3';
  PERFORM test.reset(); INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', pth, b, '{"size":500,"mimetype":"audio/mpeg"}'); PERFORM test.act_as(b, 'st-b@example.test');
  PERFORM public.attach_meeting_audio(m2, pth, 500, 'audio/mpeg', 30000);
  SELECT * INTO r FROM public.stt_reserve(sec, m2, 600000, 72000000, 360000000);
  req1 := r.request_id;
  PERFORM public.stt_fail(sec, m2, 1, NULL, 'cancelled', 'uncertain');
  PERFORM test.ok((SELECT stt_state FROM public.meetings WHERE id = m2) = 'unknown', 'F3: stt_fail(cancelled, uncertain) on a submitting attempt leaves the outcome UNKNOWN');
  PERFORM test.ok((SELECT billing_state FROM public.ai_requests WHERE id = req1) = 'uncertain', 'F3: and the estimate stays booked');
  SELECT * INTO r FROM public.stt_reserve(sec, m2, 600000, 72000000, 360000000);
  PERFORM test.ok(r.outcome = 'unknown_outcome', 'F3: so a retry is refused (no second paid POST)');
  PERFORM test.ok((SELECT count(*) FROM public.stt_jobs WHERE meeting_id = m2) = 1, 'F3: exactly one attempt row');

  -- ---- G1: machine provenance cannot be forged from SQL -----------------------------------------------------------------
  PERFORM test.act_as(b, 'st-b@example.test');
  tr := '[{"id":"seg-0","startMs":0,"endMs":1,"speakerId":null,"text":"FORGED"}]'::jsonb;
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count) values (%L, 'pSt', %L, 'soniox', '[]', %L::jsonb, 6)$q$, m, repeat('a', 64), tr::text),
                      '42501', 'G1: a forged source=soniox transcript is refused');
  PERFORM set_config('app.stt_persist', 'on', true);
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count) values (%L, 'pSt', %L, 'soniox', '[]', %L::jsonb, 6)$q$, m, repeat('b', 64), tr::text),
                      '42501', 'G1: setting the old session flag app.stt_persist no longer helps');
  PERFORM test.throws($q$insert into public.machine_persist_tokens (txid) values (txid_current())$q$, '42501', 'G1: a member cannot write a provenance token');
  PERFORM test.throws($q$select * from public.machine_persist_tokens$q$, '42501', 'G1: nor read the token table');

  -- ---- unattached uploads: listed for the sweep, never for strangers ------------------------------------------------------
  PERFORM test.reset();
  INSERT INTO storage.objects (bucket_id, name, owner, metadata, created_at) VALUES
    ('meeting-audio', 'pSt/' || m || '/' || gen_random_uuid() || '.mp3', b, '{"size":10,"mimetype":"audio/mpeg"}', now() - interval '3 days'),
    ('meeting-audio', 'pSt/' || m || '/' || gen_random_uuid() || '.mp3', b, '{"size":10,"mimetype":"audio/mpeg"}', now());
  PERFORM test.act_as(b, 'st-b@example.test');
  SELECT count(*) INTO n FROM public.list_project_audio('pSt');
  PERFORM test.ok(n = 1, 'sweep: only the OLD unattached upload is listed (the registered file and a fresh upload are not)');
  SELECT count(*) INTO n FROM public.list_project_audio('pSt', FALSE, 0);
  PERFORM test.ok(n = 4, 'project delete: every object of the project is listed (2 registered + 2 unattached)');
  PERFORM test.act_as(c, 'st-c@example.test');
  SELECT count(*) INTO n FROM public.list_project_audio('pSt', FALSE, 0);
  PERFORM test.ok(n = 0, 'a stranger sees no objects of the project');
END $$;
