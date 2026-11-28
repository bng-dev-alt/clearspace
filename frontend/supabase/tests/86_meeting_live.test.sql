-- RUN 10 (migration 1800): live meeting transcription bookkeeping, scheduling columns, attendees, Calendar resource links.
-- Database level only: no provider is contacted. L = live, S = schedule/links, X = isolation/deletion.
DO $$
DECLARE
  a uuid := test.mkuser('ml-a@example.test');   -- project owner
  b uuid := test.mkuser('ml-b@example.test');   -- project member (organizer of m)
  c uuid := test.mkuser('ml-c@example.test');   -- stranger
  sec text := repeat('l', 40);
  m uuid; m2 uuid; mo uuid; r record; rev text; tr jsonb; n int; lnk uuid; lnk2 uuid; req uuid;
BEGIN
  PERFORM test.act_as(a, 'ml-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pMl', 'Live'), ('pMl2', 'Live other');
  PERFORM test.reset();
  INSERT INTO public.project_members (project_id, member_id) SELECT 'pMl', id FROM public.workspace_members WHERE profile_id = b;
  INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('stt', encode(sha256(convert_to(sec, 'UTF8')), 'hex'))
    ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;

  -- ---- S: a scheduled meeting without any audio file, with a conferencing link and an end ----------------------------------
  PERFORM test.act_as(b, 'ml-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind, occurred_at, ends_at, conference_url)
  VALUES ('pMl', 'Týdenní porada', 'audio', now() + interval '1 day', now() + interval '1 day 1 hour', 'https://meet.google.com/abc-defg-hij')
  RETURNING id INTO m;
  PERFORM test.ok((SELECT status || ':' || live_state FROM public.meetings WHERE id = m) = 'draft:idle', 'S1: a planned meeting is a draft with idle capture');
  PERFORM test.throws(format($q$update public.meetings set conference_url = 'javascript:alert(1)' where id = %L$q$, m), '23514', 'S2: only https conference links');
  PERFORM test.throws(format($q$update public.meetings set ends_at = occurred_at - interval '1 minute' where id = %L$q$, m), '23514', 'S3: the end is never before the start');
  PERFORM test.throws(format($q$update public.meetings set live_state = 'finalized' where id = %L$q$, m), '42501', 'S4: members cannot write the live state');
  INSERT INTO public.meeting_attendees (meeting_id, project_id, email, display_name) VALUES (m, 'pMl', 'guest@example.org', 'Host');
  PERFORM test.throws(format($q$insert into public.meeting_attendees (meeting_id, project_id, email) values (%L, 'pMl', 'Upper@Example.org')$q$, m), '23514', 'S5: attendee e-mails are stored normalised (lower case)');
  PERFORM test.throws(format($q$insert into public.meeting_attendees (meeting_id, project_id, email) values (%L, 'pMl2', 'x@example.org')$q$, m), NULL, 'S6: an attendee row cannot point to another project (RLS + composite FK)');
  -- a project-level link may be attached, a link of another project may not
  PERFORM test.reset();
  INSERT INTO public.external_resource_links (project_id, provider, external_id, name, mime_type, web_url, linked_by)
  VALUES ('pMl', 'google_drive', 'abcdefghijKLMN', 'Zápis', 'text/plain', 'https://drive.google.com/x', b) RETURNING id INTO lnk;
  INSERT INTO public.external_resource_links (project_id, provider, external_id, name, mime_type, web_url, linked_by)
  VALUES ('pMl2', 'google_drive', 'zzzzzzzzzzZZZZ', 'Cizí', 'text/plain', 'https://drive.google.com/y', a) RETURNING id INTO lnk2;
  PERFORM test.act_as(b, 'ml-b@example.test');
  INSERT INTO public.meeting_resource_links (meeting_id, link_id, project_id) VALUES (m, lnk, 'pMl');
  PERFORM test.ok((SELECT count(*) FROM public.meeting_resource_links WHERE meeting_id = m) = 1, 'S7: a project link is attached to the meeting');
  PERFORM test.throws(format($q$insert into public.meeting_resource_links (meeting_id, link_id, project_id) values (%L, %L, 'pMl')$q$, m, lnk2),
    '22023', 'S8: a link of another project is refused');

  -- ---- L1: no booking without the organizer's notice declaration; the declaration is required first ------------------------
  SELECT * INTO r FROM public.stt_live_reserve(sec, m, 600000, 3600000, 36000000);
  PERFORM test.ok(r.outcome = 'no_consent', 'L1: live capture needs the recorded notice declaration');
  PERFORM test.throws(format($q$select * from public.stt_live_reserve(%L, %L, 600000, 3600000, 36000000)$q$, repeat('x', 40), m), '42501', 'L1: the server secret is required');
  PERFORM public.record_audio_consent(m);

  -- ---- L2: booking before the key, one open segment, double start refused ---------------------------------------------------
  SELECT * INTO r FROM public.stt_live_reserve(sec, m, 600000, 3600000, 36000000);
  PERFORM test.ok(r.outcome = 'started' AND r.segment = 1 AND r.offset_ms = 0 AND r.reserved_ms = 600000, 'L2: segment 1 booked for 10 min');
  req := r.request_id;
  PERFORM test.ok((SELECT billing_state || ':' || audio_ms FROM public.ai_requests WHERE id = req) = 'reserved:600000', 'L2: the reservation is in the shared STT ledger before any provider call');
  SELECT * INTO r FROM public.stt_live_reserve(sec, m, 600000, 3600000, 36000000);
  PERFORM test.ok(r.outcome = 'already_live', 'L2: a second start while live is refused (no duplicate paid stream)');
  PERFORM test.ok((SELECT live_state FROM public.meetings WHERE id = m) = 'live', 'L2: meeting shows live');

  -- ---- L3: progressive chunks, idempotent per seq; only the segment's own user may append -----------------------------------
  tr := '[{"text":"Dobrý","start_ms":0,"end_ms":400,"speaker":"1"},{"text":" den","start_ms":400,"end_ms":700,"speaker":"1"}]';
  PERFORM test.ok(public.stt_live_append(sec, m, 1, 1, tr) = 'ok', 'L3: chunk 1 stored');
  PERFORM public.stt_live_append(sec, m, 1, 1, tr);
  PERFORM test.ok((SELECT count(*) FROM public.meeting_live_chunks WHERE meeting_id = m) = 1, 'L3: a retried chunk is stored once');
  PERFORM test.throws(format($q$select public.stt_live_append(%L, %L, 7, 1, '[{"text":"x"}]')$q$, sec, m), '22023', 'L3: no chunk for a segment that does not exist');
  PERFORM test.act_as(a, 'ml-a@example.test');
  PERFORM test.throws(format($q$select public.stt_live_append(%L, %L, 1, 2, '[{"text":"x"}]')$q$, sec, m), '22023', 'L3: another member cannot inject text into the organizer''s segment');
  PERFORM test.ok((SELECT count(*) FROM public.meeting_live_chunks WHERE meeting_id = m) = 1, 'L3: project members can read the partial transcript');

  -- ---- L4: pause settles at most the wall time; resume books a new segment with an offset ------------------------------------
  PERFORM test.act_as(b, 'ml-b@example.test');
  n := public.stt_live_close(sec, m, 1, 999999, 'paused');
  PERFORM test.ok(n <= 16000, 'L4: a client cannot over- or under-state beyond wall time (+15 s grace): charged ' || n || ' ms');
  PERFORM test.ok((SELECT billing_state FROM public.ai_requests WHERE id = req) = 'estimated', 'L4: the booking is settled as an estimate');
  PERFORM test.ok((SELECT live_state FROM public.meetings WHERE id = m) = 'paused', 'L4: paused');
  SELECT * INTO r FROM public.stt_live_reserve(sec, m, 600000, 3600000, 36000000);
  PERFORM test.ok(r.outcome = 'started' AND r.segment = 2 AND r.offset_ms = n, 'L4: resume = segment 2 offset by the first segment');
  -- a failed key mint releases the booking completely (nothing was streamed)
  PERFORM public.stt_live_release(sec, m, 2);
  PERFORM test.ok((SELECT count(*) FROM public.meeting_live_segments WHERE meeting_id = m) = 1
                  AND (SELECT live_segments || ':' || live_state FROM public.meetings WHERE id = m) = '1:paused', 'L4: a released booking leaves no segment');
  PERFORM test.ok((SELECT billing_state FROM public.ai_requests WHERE user_id = b AND status = 'failed' ORDER BY created_at DESC LIMIT 1) = 'not_billed', 'L4: and is not billed');

  -- ---- L5: budgets are shared with the async path and cap the reservation ------------------------------------------------------
  SELECT * INTO r FROM public.stt_live_reserve(sec, m, 600000, n + 30000, 36000000);
  PERFORM test.ok(r.outcome = 'budget_exceeded', 'L5: under one minute of daily budget left -> refused before any key');
  SELECT * INTO r FROM public.stt_live_reserve(sec, m, 7200000, n + 120000, 36000000);
  PERFORM test.ok(r.outcome = 'started' AND r.reserved_ms = 120000, 'L5: the reservation shrinks to the remaining daily budget (provider cap = booking)');
  PERFORM public.stt_live_append(sec, m, r.segment, 1, '[{"text":" znovu","start_ms":0,"end_ms":300,"speaker":"1"}]');

  -- ---- L6: only the organizer completes; completion writes ONE machine revision and drops the chunks --------------------------
  tr := jsonb_build_object('revision', repeat('c', 64), 'speakers', '[]'::jsonb, 'segments',
        '[{"id":"g1","speakerId":null,"startMs":0,"endMs":700,"text":"Dobrý den znovu"}]'::jsonb, 'char_count', 15);
  PERFORM test.act_as(c, 'ml-c@example.test');
  PERFORM test.throws(format($q$select public.stt_live_complete(%L, %L, 'stt-rt-v6', %L::jsonb)$q$, sec, m, tr::text), NULL, 'X1: a stranger cannot complete');
  PERFORM test.ok((SELECT count(*) FROM public.meeting_live_chunks WHERE meeting_id = m) = 0, 'X1: and cannot read the chunks');
  PERFORM test.act_as(b, 'ml-b@example.test');
  rev := public.stt_live_complete(sec, m, 'stt-rt-v6', tr);
  PERFORM test.ok(rev = repeat('c', 64), 'L6: revision stored');
  PERFORM test.ok((SELECT status || ':' || live_state || ':' || stt_state FROM public.meetings WHERE id = m) = 'transcribed:finalized:completed', 'L6: meeting transcribed');
  PERFORM test.ok((SELECT source FROM public.meeting_transcripts WHERE meeting_id = m) = 'soniox', 'L6: machine provenance');
  PERFORM test.ok((SELECT count(*) FROM public.meeting_live_chunks WHERE meeting_id = m) = 0, 'L6: chunks deleted (minimisation)');
  PERFORM test.ok((SELECT count(*) FROM public.meeting_live_segments WHERE meeting_id = m AND state = 'open') = 0, 'L6: the open segment was settled (full reservation, unknown duration)');
  PERFORM test.ok(public.stt_live_complete(sec, m, 'stt-rt-v6', tr) = rev, 'L6: completion is idempotent');
  SELECT * INTO r FROM public.stt_live_reserve(sec, m, 600000, 3600000, 36000000);
  PERFORM test.ok(r.outcome = 'finalized', 'L6: no new paid stream after finalisation');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count) values (%L, 'pMl', %L, 'soniox', '[]', '[]', 0)$q$, m, repeat('d', 64)),
    NULL, 'L6: a member still cannot forge a soniox revision');

  -- ---- L7: only the organizer (creator or project owner) may start; members may not -----------------------------------------
  PERFORM test.act_as(a, 'ml-a@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pMl', 'Porada vlastníka', 'audio') RETURNING id INTO mo;
  PERFORM public.record_audio_consent(mo);
  PERFORM test.act_as(b, 'ml-b@example.test');
  SELECT * INTO r FROM public.stt_live_reserve(sec, mo, 600000, 3600000, 36000000);
  PERFORM test.ok(r.outcome = 'not_organizer', 'L7: a plain member cannot start capture of someone else''s meeting');
  PERFORM test.act_as(c, 'ml-c@example.test');
  PERFORM test.throws(format($q$select * from public.stt_live_reserve(%L, %L, 600000, 3600000, 36000000)$q$, sec, mo), NULL, 'X2: a stranger cannot even book');
  PERFORM test.ok((SELECT count(*) FROM public.meetings WHERE id = mo) = 0, 'X2: and does not see the meeting');

  -- ---- L8: an abandoned stream (tab closed) keeps its full reservation and is reaped --------------------------------------------
  PERFORM test.act_as(a, 'ml-a@example.test');
  SELECT * INTO r FROM public.stt_live_reserve(sec, mo, 60000, 3600000, 36000000);
  PERFORM test.reset();
  UPDATE public.meeting_live_segments SET started_at = now() - interval '10 minutes' WHERE meeting_id = mo;
  PERFORM test.act_as(a, 'ml-a@example.test');
  SELECT * INTO r FROM public.stt_live_reserve(sec, mo, 60000, 3600000, 36000000);
  PERFORM test.ok(r.outcome = 'started' AND r.segment = 2, 'L8: the stale stream is reaped, a new one may start');
  PERFORM test.ok((SELECT state || ':' || audio_ms FROM public.meeting_live_segments WHERE meeting_id = mo AND segment = 1) = 'abandoned:60000', 'L8: the abandoned stream is charged in full');

  -- ---- X3: deleting a meeting removes chunks, segments, attendees and links; the usage ledger survives -------------------------
  PERFORM public.stt_live_append(sec, mo, 2, 1, '[{"text":"tajné"}]');
  DELETE FROM public.meetings WHERE id = mo;
  PERFORM test.reset();
  PERFORM test.ok((SELECT count(*) FROM public.meeting_live_chunks WHERE meeting_id = mo) = 0
                  AND (SELECT count(*) FROM public.meeting_live_segments WHERE meeting_id = mo) = 0, 'X3: chunks + segments gone with the meeting');
  PERFORM test.ok((SELECT count(*) FROM public.ai_requests WHERE user_id = a AND feature = 'meeting-transcribe') = 2, 'X3: money is never erased by a deletion');
  PERFORM test.act_as(b, 'ml-b@example.test');
  DELETE FROM public.meetings WHERE id = m;
  PERFORM test.reset();
  PERFORM test.ok((SELECT count(*) FROM public.meeting_attendees WHERE meeting_id = m) = 0
                  AND (SELECT count(*) FROM public.meeting_resource_links WHERE meeting_id = m) = 0
                  AND (SELECT count(*) FROM public.external_resource_links WHERE id = lnk) = 1, 'X3: attendees + link rows go, the project link itself stays');
END $$;
