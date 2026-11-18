-- Intelligence core (meetings, transcripts, runs, items): isolation, evidence integrity, atomic persist,
-- review state machine, idempotent/duplicate-safe apply, undo, privacy cascade.
DO $$
DECLARE
  a uuid := test.mkuser('int-a@example.test');   -- project owner
  b uuid := test.mkuser('int-b@example.test');   -- project member
  c uuid := test.mkuser('int-c@example.test');   -- stranger (own project pC)
  rev text := repeat('a', 64);
  rev2 text := repeat('b', 64);
  segs jsonb := jsonb_build_array(
    jsonb_build_object('id', 'seg-0', 'startMs', 0,    'endMs', 5000,  'speakerId', 'S1', 'text', 'Rozhodli jsme, že release posuneme na pátek.'),
    jsonb_build_object('id', 'seg-1', 'startMs', 5000, 'endMs', 11000, 'speakerId', 'S2', 'text', 'Honza připraví migraci databáze do 25. listopadu.'),
    jsonb_build_object('id', 'seg-2', 'startMs', 11000,'endMs', 15000, 'speakerId', 'S2', 'text', 'Riziko: dodavatel může zpozdit certifikát.'));
  m1 uuid; m2 uuid; mc uuid; mfail uuid;
  run jsonb; run2 jsonb; items jsonb; items2 jsonb;
  r1 uuid; r2 uuid; m2run uuid;
  wm_a text;
  ai1 uuid; ai2 uuid; v_dec uuid; v_risk uuid; dupe uuid; old1 uuid;
  res jsonb; card1 text; n int; n2 int;
  ev_ok jsonb := jsonb_build_array(jsonb_build_object('ref','segment:seg-1','quote','Honza připraví migraci databáze','quoteFound',true,'startMs',5000,'endMs',11000));
  ev_dec jsonb := jsonb_build_array(jsonb_build_object('ref','segment:seg-0','quote','release posuneme na pátek','quoteFound',true));
  ev_risk jsonb := jsonb_build_array(jsonb_build_object('ref','segment:seg-2','quote','dodavatel může zpozdit','quoteFound',false));
BEGIN
  -- ---- setup: A owns pI (+ pI2), B is a member of pI, C owns pC --------------------------------------------------
  PERFORM test.act_as(a, 'int-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pI', 'Intelligence'), ('pI2', 'Second');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('pI-col', 'pI', 'Todo', 0), ('pI2-col', 'pI2', 'Todo', 0);
  INSERT INTO public.cards (id, column_id, title) VALUES ('pI-card', 'pI-col', 'Existing card'), ('pI2-card', 'pI2-col', 'Other project card');
  SELECT id INTO wm_a FROM public.workspace_members WHERE profile_id = a;
  PERFORM test.act_as(c, 'int-c@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pC', 'Stranger');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('pC-col', 'pC', 'Todo', 0);
  INSERT INTO public.cards (id, column_id, title) VALUES ('pC-card', 'pC-col', 'C card');
  PERFORM test.reset();
  INSERT INTO public.project_members (project_id, member_id) SELECT 'pI', id FROM public.workspace_members WHERE profile_id = b;

  run := jsonb_build_object('status','succeeded','transcript_revision',rev,'input_fingerprint','fp1',
           'contract_version','cs.meeting-brief@1.0','prompt_version','meeting-brief-p1','validator_version','cs-evidence-v1',
           'model','gemini-test','output',jsonb_build_object('summary','Shrnutí'),'rejected_count',2);

  -- ================= meetings: isolation =================
  PERFORM test.act_as(b, 'int-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pI', 'Týdenní porada', 'text') RETURNING id INTO m1;
  PERFORM test.ok(m1 IS NOT NULL AND (select created_by from public.meetings where id = m1) = b, 'member creates a meeting; created_by defaults to the caller');
  PERFORM test.ok((select status from public.meetings where id = m1) = 'draft', 'new meeting starts as draft');

  PERFORM test.act_as(c, 'int-c@example.test');
  PERFORM test.ok((select count(*) from public.meetings) = 0, 'stranger sees no meetings');
  PERFORM test.throws($q$insert into public.meetings (project_id, title, source_kind) values ('pI', 'evil', 'text')$q$, '42501', 'stranger cannot create a meeting in a foreign project');
  PERFORM test.act_as(b, 'int-b@example.test');
  PERFORM test.throws(format($q$insert into public.meetings (project_id, title, source_kind, created_by) values ('pI', 'spoof', 'text', %L)$q$, a), '42501', 'created_by cannot be spoofed');
  PERFORM test.throws($q$update public.meetings set project_id = 'pI2' where title = 'Týdenní porada'$q$, '42501', 'a meeting cannot be moved to another project (no column privilege)');
  PERFORM test.throws($q$update public.meetings set status = 'ready' where title = 'Týdenní porada'$q$, '42501', 'clients cannot write meeting status');
  PERFORM test.throws($q$insert into public.meetings (project_id, title, source_kind) values ('pI', '   ', 'text')$q$, '23514', 'blank title is refused');
  UPDATE public.meetings SET title = 'Týdenní porada 2' WHERE id = m1;
  PERFORM test.ok((select title from public.meetings where id = m1) = 'Týdenní porada 2', 'member can rename and edit speaker names');
  UPDATE public.meetings SET speaker_names = '{"S1":"Petr Novák"}' WHERE id = m1;

  PERFORM test.act_as(c, 'int-c@example.test');
  UPDATE public.meetings SET title = 'hacked' WHERE id = m1; GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'stranger update affects 0 rows');
  DELETE FROM public.meetings WHERE id = m1; GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'stranger delete affects 0 rows');
  PERFORM test.act_as_anon();
  PERFORM test.throws('select * from public.meetings', '42501', 'anon cannot read meetings');
  PERFORM test.throws('select * from public.intelligence_items', '42501', 'anon cannot read items');

  -- ================= transcripts =================
  PERFORM test.act_as(b, 'int-b@example.test');
  INSERT INTO public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count)
  VALUES (m1, 'pI', rev, 'paste', '[{"id":"S1","label":"Mluvčí 1"}]'::jsonb, segs, 140);
  PERFORM test.ok((select current_revision from public.meetings where id = m1) = rev, 'transcript insert makes it the current revision');
  PERFORM test.ok((select status from public.meetings where id = m1) = 'transcribed', 'meeting status moved to transcribed by the database');
  PERFORM test.throws(format($q$update public.meeting_transcripts set char_count = 5 where meeting_id = %L$q$, m1), '42501', 'transcripts are immutable (no UPDATE)');
  PERFORM test.throws(format($q$delete from public.meeting_transcripts where meeting_id = %L$q$, m1), '42501', 'transcripts cannot be deleted directly');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, segments, char_count) values (%L, 'pI', %L, 'paste', '[{"id":"x","text":"a"},{"id":"x","text":"b"}]'::jsonb, 2)$q$, m1, rev2), '22023', 'duplicate segment ids are refused');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, segments, char_count) values (%L, 'pI', %L, 'paste', '[]'::jsonb, 1)$q$, m1, rev2), '23514', 'empty transcript is refused');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, segments, char_count) values (%L, 'pI', 'not-a-hash', 'paste', '[{"id":"x","text":"a"}]'::jsonb, 1)$q$, m1), '23514', 'revision must be a sha256 hex');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, segments, char_count) values (%L, 'pI', %L, 'paste', '[{"id":"x","text":"  "}]'::jsonb, 1)$q$, m1, rev2), '22023', 'blank segment text is refused');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, segments, char_count) values (%L, 'pI', %L, 'paste', jsonb_build_array(jsonb_build_object('id','x','text',repeat('x',400001))), 400000)$q$, m1, rev2), '22023', 'transcript over 400k characters is refused');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, segments, char_count) values (%L, 'pI', %L, 'paste', '[{"id":"a b","text":"x"}]'::jsonb, 1)$q$, m1, rev2), '22023', 'segment ids with whitespace are refused');

  PERFORM test.act_as(a, 'int-a@example.test');   -- owner of both pI and pI2
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, segments, char_count) values (%L, 'pI2', %L, 'paste', '[{"id":"x","text":"a"}]'::jsonb, 1)$q$, m1, rev2), '23503', 'a transcript cannot point at a meeting of ANOTHER project (composite FK)');
  PERFORM test.act_as(c, 'int-c@example.test');
  PERFORM test.ok((select count(*) from public.meeting_transcripts) = 0, 'stranger cannot read transcripts');
  PERFORM test.throws(format($q$insert into public.meeting_transcripts (meeting_id, project_id, revision, source, segments, char_count) values (%L, 'pI', %L, 'paste', '[{"id":"x","text":"a"}]'::jsonb, 1)$q$, m1, rev2), '42501', 'stranger cannot add a transcript');

  -- ================= persist_meeting_run: atomic, evidence-checked, idempotent =================
  items := jsonb_build_array(
    jsonb_build_object('kind','action_item','text','Honza připraví migraci databáze.','support','linked','evidence',ev_ok,'owner_text','Honza','due_text','25. listopadu','dedupe_key',repeat('1',64)),
    jsonb_build_object('kind','action_item','text','Ověřit certifikát u dodavatele.','support','linked','evidence',ev_ok,'dedupe_key',repeat('2',64)),
    jsonb_build_object('kind','decision','text','Release se posouvá na pátek.','support','linked','evidence',ev_dec,'dedupe_key',repeat('3',64)),
    jsonb_build_object('kind','risk','text','Dodavatel může zpozdit certifikát.','support','unverified','evidence',ev_risk,'dedupe_key',repeat('4',64)));

  PERFORM test.act_as(c, 'int-c@example.test');
  PERFORM test.throws(format($q$select public.persist_meeting_run(%L, %L::jsonb, %L::jsonb)$q$, m1, run::text, items::text), '42501', 'stranger cannot persist a run for a foreign meeting');

  PERFORM test.act_as(b, 'int-b@example.test');
  PERFORM test.throws(format($q$select public.persist_meeting_run(%L, %L::jsonb, %L::jsonb)$q$, m1,
    jsonb_set(run, '{transcript_revision}', to_jsonb(rev2))::text, items::text), '22023', 'unknown transcript revision is refused');
  PERFORM test.throws(format($q$select public.persist_meeting_run(%L, %L::jsonb, %L::jsonb)$q$, m1, run::text,
    jsonb_build_array(jsonb_set(items -> 0, '{evidence}', jsonb_build_array(jsonb_build_object('ref','segment:seg-999','quote','Honza připraví migraci','quoteFound',true))))::text), '22023', 'FABRICATED evidence (unknown segment) is refused');
  -- (an unsupported decision/action and a forged "linked" are no longer errors: the database downgrades/skips them; see 83_intelligence_hardening.test.sql)
  PERFORM test.throws(format($q$select public.persist_meeting_run(%L, %L::jsonb, %L::jsonb)$q$, m1, run::text,
    jsonb_build_array(jsonb_set(items -> 0, '{evidence}', '[]'))::text), '22023', 'an item without evidence is refused');
  PERFORM test.throws(format($q$select public.persist_meeting_run(%L, %L::jsonb, %L::jsonb)$q$, m1, run::text,
    jsonb_build_array(jsonb_set(items -> 0, '{evidence}', jsonb_build_array(ev_ok -> 0, ev_ok -> 0, ev_ok -> 0, ev_ok -> 0, ev_ok -> 0)))::text), '22023', 'more than 4 evidence entries are refused');
  PERFORM test.throws(format($q$select public.persist_meeting_run(%L, %L::jsonb, %L::jsonb)$q$, m1, run::text,
    jsonb_build_array(jsonb_set(items -> 0, '{suggested_card_id}', '"pI2-card"'))::text), '22023', 'a suggested card of another project is refused');
  PERFORM test.throws(format($q$select public.persist_meeting_run(%L, %L::jsonb, %L::jsonb)$q$, m1, run::text,
    jsonb_build_array(items -> 0, jsonb_set(items -> 1, '{evidence}', jsonb_build_array(jsonb_build_object('ref','segment:nope','quoteFound',true))))::text), '22023', 'second item invalid -> the WHOLE persist is refused');
  PERFORM test.ok((select count(*) from public.intelligence_runs where meeting_id = m1) = 0, 'transaction rollback: no run row remains after a refused persist');
  PERFORM test.ok((select count(*) from public.intelligence_items) = 0, 'transaction rollback: no item rows remain');
  PERFORM test.throws(format($q$select public.persist_meeting_run(%L, %L::jsonb, %L::jsonb)$q$, m1, jsonb_set(run,'{status}','"failed"')::text, items::text), '22023', 'a failed run cannot carry items');
  PERFORM test.throws(format($q$insert into public.intelligence_runs (project_id, meeting_id, kind, status, transcript_revision, input_fingerprint, contract_version, prompt_version, validator_version) values ('pI', %L, 'meeting_brief', 'succeeded', %L, 'x', 'c', 'p', 'v')$q$, m1, rev), '42501', 'clients cannot INSERT runs directly');

  SELECT public.persist_meeting_run(m1, run, items) INTO r1;
  PERFORM test.ok(r1 IS NOT NULL, 'valid run is persisted');
  PERFORM test.ok((select count(*) from public.intelligence_items i where i.run_id = r1) = 4, 'all 4 items stored');
  PERFORM test.ok((select count(*) from public.intelligence_items i where i.run_id = r1 and i.review_state = 'proposed') = 4, 'items start as proposed (AI never self-approves)');
  PERFORM test.ok((select status from public.meetings where id = m1) = 'ready', 'meeting becomes ready');
  PERFORM test.ok((select rejected_count from public.intelligence_runs x where x.id = r1) = 2, 'run keeps provenance (rejected_count)');
  PERFORM test.ok((select assignee_member_id is null and due_date is null from public.intelligence_items i where i.run_id = r1 and i.ordinal = 0), 'AI never sets assignee or due date');
  PERFORM test.throws(format($q$select public.persist_meeting_run(%L, %L::jsonb, %L::jsonb)$q$, m1, run::text, items::text), '23505', 'IDEMPOTENCY: the same revision + prompt version is not analysed twice');
  PERFORM test.ok((select count(*) from public.intelligence_runs where meeting_id = m1) = 1 AND (select count(*) from public.intelligence_items) = 4, 'repeated persist wrote nothing');

  -- forced re-run supersedes the previous run and its open items
  SELECT id INTO old1 FROM public.intelligence_items WHERE run_id = r1 AND ordinal = 0;
  SELECT public.persist_meeting_run(m1, run, items, true) INTO r2;
  PERFORM test.ok((select superseded_at is not null from public.intelligence_runs x where x.id = r1), 'forced re-run supersedes the old run');
  PERFORM test.ok((select count(*) from public.intelligence_items i where i.run_id = r1 and i.review_state = 'superseded') = 4, 'old open items are superseded');
  PERFORM test.ok((select count(*) from public.intelligence_runs where meeting_id = m1 and superseded_at is null) = 1, 'exactly one active run');

  SELECT id INTO ai1 FROM public.intelligence_items i WHERE i.run_id = r2 AND i.ordinal = 0;
  SELECT id INTO ai2 FROM public.intelligence_items i WHERE i.run_id = r2 AND i.ordinal = 1;
  SELECT id INTO v_dec FROM public.intelligence_items i WHERE i.run_id = r2 AND i.ordinal = 2;
  SELECT id INTO v_risk FROM public.intelligence_items i WHERE i.run_id = r2 AND i.ordinal = 3;

  -- ================= review state machine =================
  PERFORM test.act_as(c, 'int-c@example.test');
  PERFORM test.ok((select count(*) from public.intelligence_items) = 0 AND (select count(*) from public.intelligence_runs) = 0, 'stranger sees no runs or items');
  PERFORM test.throws(format($q$select public.review_intelligence_item(%L, 'accept')$q$, ai1), '42501', 'stranger cannot review');
  PERFORM test.throws(format($q$select public.apply_intelligence_item(%L, '{"mode":"create_card","column_id":"pI-col"}'::jsonb)$q$, ai1), '42501', 'stranger cannot apply');

  PERFORM test.act_as(b, 'int-b@example.test');
  PERFORM test.throws(format($q$select public.review_intelligence_item(%L, 'approve-all')$q$, ai1), '22023', 'invalid decision is refused');
  res := public.review_intelligence_item(ai1, 'accept', jsonb_build_object('text', 'Honza připraví migraci DB', 'assignee_member_id', wm_a, 'due_date', '2026-11-25'));
  PERFORM test.ok(res ->> 'review_state' = 'accepted', 'member accepts an item');
  PERFORM test.ok((select text = 'Honza připraví migraci DB' and assignee_member_id = wm_a and due_date = date '2026-11-25' and decided_by = b from public.intelligence_items where id = ai1), 'a HUMAN sets text, assignee and due date');
  res := public.review_intelligence_item(ai1, 'accept');
  PERFORM test.ok((res ->> 'unchanged')::boolean, 'repeated accept is a no-op');
  PERFORM test.throws(format($q$update public.intelligence_items set evidence = '[]'::jsonb where id = %L$q$, ai1), '42501', 'AI evidence cannot be edited (no column privilege)');
  PERFORM test.throws(format($q$update public.intelligence_items set kind = 'risk' where id = %L$q$, ai1), '42501', 'item kind cannot be edited');
  PERFORM test.throws(format($q$update public.intelligence_items set review_state = 'applied', applied_card_id = 'ghost', applied_mode = 'create_card', applied_at = now() where id = %L$q$, ai1), '42501', 'cannot forge "applied" with a non-existent card');
  PERFORM test.throws(format($q$update public.intelligence_items set review_state = 'applied', applied_card_id = 'pC-card', applied_mode = 'create_card', applied_at = now() where id = %L$q$, ai1), '42501', 'cannot forge "applied" with a card of another project');
  PERFORM test.throws(format($q$update public.intelligence_items set review_state = 'applied' where id = %L$q$, ai1), '55000', 'applied without a card is refused');
  PERFORM test.throws(format($q$update public.intelligence_items set review_state = 'applied', applied_card_id = 'pI-card', applied_mode = 'comment', applied_at = now() where id = %L$q$, ai2), '55000', 'a proposed item cannot jump straight to applied (state machine)');
  PERFORM test.throws(format($q$update public.intelligence_items set review_state = 'proposed' where id = %L$q$, old1), '55000', 'a superseded item is terminal');
  PERFORM test.throws(format($q$select public.apply_intelligence_item(%L, '{"mode":"create_card","column_id":"pI-col"}'::jsonb)$q$, old1), '55000', 'a superseded item cannot be applied');

  -- reject / reopen
  res := public.review_intelligence_item(v_risk, 'reject');
  PERFORM test.ok(res ->> 'review_state' = 'rejected', 'item can be rejected');
  PERFORM test.throws(format($q$select public.apply_intelligence_item(%L, '{"mode":"comment","card_id":"pI-card"}'::jsonb)$q$, v_risk), '55000', 'a rejected item cannot be applied');
  PERFORM test.throws(format($q$update public.intelligence_items set review_state = 'accepted' where id = %L$q$, v_risk), '55000', 'rejected -> accepted directly is not a valid transition');
  PERFORM test.throws(format($q$update public.intelligence_items set text = 'edited' where id = %L$q$, v_risk), '55000', 'a rejected item cannot be edited');
  res := public.review_intelligence_item(v_risk, 'reopen');
  PERFORM test.ok(res ->> 'review_state' = 'proposed', 'reopen returns a rejected item to proposed');

  -- ================= apply: create card (transactional, idempotent) =================
  SELECT count(*) INTO n FROM public.cards WHERE column_id = 'pI-col';
  PERFORM test.throws(format($q$select public.apply_intelligence_item(%L, '{"mode":"create_card","column_id":"pI-col","due_date":"2026-02-30"}'::jsonb)$q$, ai2), '22023', 'invalid due date refused');
  PERFORM test.throws(format($q$select public.apply_intelligence_item(%L, '{"mode":"create_card","column_id":"pI-col","assignee_member_id":"ghost"}'::jsonb)$q$, ai2), '22023', 'unknown assignee refused');
  PERFORM test.throws(format($q$select public.apply_intelligence_item(%L, '{"mode":"create_card","column_id":"pI2-col"}'::jsonb)$q$, ai2), '42501', 'column of ANOTHER project refused');
  PERFORM test.throws(format($q$select public.apply_intelligence_item(%L, '{"mode":"create_card","column_id":"pI-col"}'::jsonb)$q$, v_dec), '22023', 'a decision cannot become a card');
  PERFORM test.throws(format($q$select public.apply_intelligence_item(%L, '{"mode":"nope"}'::jsonb)$q$, ai2), '22023', 'unknown apply mode refused');
  PERFORM test.ok((select count(*) from public.cards where column_id = 'pI-col') = n, 'rollback: failed applies created no card');
  PERFORM test.ok((select review_state from public.intelligence_items where id = ai2) = 'proposed', 'rollback: failed applies left the item proposed');

  res := public.apply_intelligence_item(ai1, jsonb_build_object('mode','create_card','column_id','pI-col','title','Migrace DB','details','Z porady','due_date','2026-11-25','assignee_member_id',wm_a));
  card1 := res ->> 'card_id';
  PERFORM test.ok(card1 IS NOT NULL AND NOT (res ->> 'already_applied')::boolean, 'apply creates a card after human confirmation');
  PERFORM test.ok((select count(*) from public.cards where column_id = 'pI-col') = n + 1, 'exactly one new card');
  PERFORM test.ok((select title = 'Migrace DB' and due_date = '2026-11-25' and position = 1 from public.cards where id = card1), 'card has the human-confirmed title and date, appended at the end');
  PERFORM test.ok((select count(*) from public.card_assignees where card_id = card1 and member_id = wm_a) = 1, 'assignee linked');
  PERFORM test.ok((select count(*) from public.activity_logs where card_id = card1 and action_type = 'card_created' and details -> 'source' ->> 'itemId' = ai1::text and actor_id = b) = 1, 'audit: activity log records source item and actor');
  PERFORM test.ok((select review_state = 'applied' and applied_card_id = card1 and applied_mode = 'create_card' from public.intelligence_items where id = ai1), 'item is applied and linked to the card');
  res := public.apply_intelligence_item(ai1, jsonb_build_object('mode','create_card','column_id','pI-col'));
  PERFORM test.ok((res ->> 'already_applied')::boolean AND res ->> 'card_id' = card1, 'IDEMPOTENCY: a second apply returns the first card');
  PERFORM test.ok((select count(*) from public.cards where column_id = 'pI-col') = n + 1 AND (select count(*) from public.activity_logs where details -> 'source' ->> 'itemId' = ai1::text) = 1, 'second apply wrote nothing');
  PERFORM test.throws(format($q$select public.review_intelligence_item(%L, 'reject')$q$, ai1), '55000', 'an applied item cannot be rejected (undo first)');
  PERFORM test.throws(format($q$update public.intelligence_items set text = 'x' where id = %L$q$, ai1), '55000', 'an applied item cannot be edited');

  -- link to an existing card / comment
  res := public.apply_intelligence_item(v_dec, jsonb_build_object('mode','link_card','card_id','pI-card','add_comment',true));
  PERFORM test.ok(res ->> 'mode' = 'link_card' AND res ->> 'card_id' = 'pI-card', 'a decision can be linked to an existing card');
  PERFORM test.ok((select count(*) from public.task_comments where card_id = 'pI-card' and content like 'Z porady: Release se posouvá na pátek.%') = 1, 'link adds a comment with the evidence quote');
  PERFORM test.ok((select count(*) from public.cards where column_id = 'pI-col') = n + 1, 'linking creates no card');
  PERFORM test.throws(format($q$select public.apply_intelligence_item(%L, '{"mode":"comment","card_id":"pC-card"}'::jsonb)$q$, v_risk), '42501', 'cannot attach to a card of another project');

  -- ================= duplicate prevention across meetings =================
  PERFORM test.act_as(a, 'int-a@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pI', 'Druhá porada', 'text') RETURNING id INTO m2;
  INSERT INTO public.meeting_transcripts (meeting_id, project_id, revision, source, segments, char_count) VALUES (m2, 'pI', rev, 'paste', segs, 140);
  run2 := jsonb_set(run, '{input_fingerprint}', '"fp2"');
  items2 := jsonb_build_array(jsonb_build_object('kind','action_item','text','Honza připraví migraci databáze.','support','linked','evidence',ev_ok,'dedupe_key',repeat('1',64)));
  SELECT public.persist_meeting_run(m2, run2, items2) INTO m2run;
  SELECT id INTO dupe FROM public.intelligence_items i WHERE i.run_id = m2run;
  PERFORM test.ok((select duplicate_of = ai1 from public.intelligence_items where id = dupe), 'same dedupe key as an applied item marks the new item as a possible duplicate');
  PERFORM test.throws(format($q$select public.apply_intelligence_item(%L, '{"mode":"create_card","column_id":"pI-col"}'::jsonb)$q$, dupe), '23505', 'DUPLICATE PREVENTION: creating the same task twice needs an explicit override');
  PERFORM test.ok((select count(*) from public.cards where column_id = 'pI-col') = n + 1, 'the duplicate was not created');
  res := public.apply_intelligence_item(dupe, jsonb_build_object('mode','create_card','column_id','pI-col','allow_duplicate',true));
  PERFORM test.ok((select count(*) from public.cards where column_id = 'pI-col') = n + 2, 'explicit override creates it');

  -- ================= undo =================
  PERFORM test.act_as(b, 'int-b@example.test');
  UPDATE public.cards SET updated_at = now() + interval '1 minute', title = 'Migrace DB (upraveno)' WHERE id = card1;
  PERFORM test.throws(format($q$select public.undo_intelligence_item(%L)$q$, ai1), '55000', 'undo of a card that changed since creation needs confirmation');
  res := public.undo_intelligence_item(ai1, true);
  PERFORM test.ok(res ->> 'review_state' = 'accepted', 'forced undo returns the item to accepted');
  PERFORM test.ok((select archived from public.cards where id = card1), 'undo ARCHIVES the card (never deletes it)');
  PERFORM test.ok((select count(*) from public.activity_logs where card_id = card1 and action_type = 'card_archived') = 1, 'undo is audited');
  PERFORM test.ok((select applied_card_id is null and applied_mode is null and applied_at is null from public.intelligence_items where id = ai1), 'applied fields cleared');
  res := public.undo_intelligence_item(ai1);
  PERFORM test.ok((res ->> 'unchanged')::boolean, 'repeated undo is a no-op');
  res := public.undo_intelligence_item(v_dec);
  PERFORM test.ok((select review_state = 'accepted' from public.intelligence_items where id = v_dec) AND (select count(*) from public.task_comments where card_id = 'pI-card') = 1, 'undo of a link keeps the comment (comments are the team''s record)');

  -- ================= project briefs =================
  run := jsonb_build_object('status','succeeded','input_fingerprint','fpB1','contract_version','cs.project-brief@1.0','prompt_version','project-brief-p1','validator_version','cs-evidence-v1','model','m','output',jsonb_build_object('summary','Brief 1'));
  SELECT public.persist_project_brief('pI', run) INTO r1;
  SELECT public.persist_project_brief('pI', jsonb_set(run, '{input_fingerprint}', '"fpB2"')) INTO r2;
  PERFORM test.ok((select count(*) from public.intelligence_runs where project_id = 'pI' and kind = 'project_brief' and superseded_at is null) = 1, 'exactly one current project brief');
  PERFORM test.ok((select superseded_at is not null from public.intelligence_runs x where x.id = r1) AND (select superseded_at is null from public.intelligence_runs x where x.id = r2), 'the previous brief is superseded, history is kept');
  PERFORM test.throws($q$select public.persist_project_brief('pI', '{"status":"weird"}'::jsonb)$q$, '22023', 'invalid brief status refused');
  PERFORM test.throws($q$select public.persist_project_brief('pI', '[]'::jsonb)$q$, '22023', 'non-object brief refused');
  PERFORM test.act_as(c, 'int-c@example.test');
  PERFORM test.throws(format($q$select public.persist_project_brief('pI', %L::jsonb)$q$, run::text), '42501', 'stranger cannot store a brief for a foreign project');
  PERFORM test.ok((select count(*) from public.intelligence_runs where project_id = 'pI') = 0, 'stranger cannot read briefs');
  PERFORM test.act_as_anon();
  PERFORM test.throws(format($q$select public.persist_project_brief('pI', %L::jsonb)$q$, run::text), '42501', 'anon cannot call persist_project_brief');
  PERFORM test.throws(format($q$select public.persist_meeting_run(%L, '{}'::jsonb, '[]'::jsonb)$q$, m1), '42501', 'anon cannot call persist_meeting_run');

  -- deleting a card that an item was applied to must not be blocked by the guard (FK SET NULL path)
  PERFORM test.act_as(a, 'int-a@example.test');
  SELECT applied_card_id INTO card1 FROM public.intelligence_items WHERE id = dupe;
  DELETE FROM public.cards WHERE id = card1; GET DIAGNOSTICS n2 = ROW_COUNT;
  PERFORM test.ok(n2 = 1 AND (select review_state = 'applied' and applied_card_id is null from public.intelligence_items where id = dupe), 'deleting the applied card keeps the item (applied, card cleared) and is not blocked');

  -- ================= deletion / privacy =================
  PERFORM test.act_as(a, 'int-a@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pI', 'Od A', 'text') RETURNING id INTO mfail;
  PERFORM test.act_as(b, 'int-b@example.test');
  DELETE FROM public.meetings WHERE id = mfail; GET DIAGNOSTICS n2 = ROW_COUNT;
  PERFORM test.ok(n2 = 0, 'a member cannot delete a meeting created by someone else');
  PERFORM test.act_as(a, 'int-a@example.test');
  SELECT count(*) INTO n FROM public.cards WHERE column_id = 'pI-col';
  DELETE FROM public.meetings WHERE id = m1; GET DIAGNOSTICS n2 = ROW_COUNT;
  PERFORM test.ok(n2 = 1, 'the project owner can delete any meeting');
  PERFORM test.ok((select count(*) from public.meeting_transcripts where meeting_id = m1) = 0
              AND (select count(*) from public.intelligence_runs where meeting_id = m1) = 0
              AND (select count(*) from public.intelligence_items where meeting_id = m1) = 0, 'deleting a meeting removes its transcripts, runs and items (privacy)');
  PERFORM test.ok((select count(*) from public.cards where column_id = 'pI-col') = n, 'cards created from the meeting stay');
  PERFORM test.reset();
  PERFORM test.ok((select count(*) from public.intelligence_items where project_id = 'pC') = 0, 'nothing leaked into the stranger''s project');
END $$;
