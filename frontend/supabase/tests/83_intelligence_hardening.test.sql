-- Hardening of the intelligence core: the DATABASE recomputes evidence, approved knowledge survives re-analysis,
-- decision metadata cannot be forged, provenance links are owned, nothing rewinds the current revision.
DO $$
DECLARE
  a uuid := test.mkuser('hd-a@example.test');   -- project owner
  b uuid := test.mkuser('hd-b@example.test');   -- project member
  c uuid := test.mkuser('hd-c@example.test');   -- stranger
  rev1 text := md5('hd1') || md5('hd1b');
  rev2 text := md5('hd2') || md5('hd2b');
  segs jsonb := jsonb_build_array(
    jsonb_build_object('id','seg-0','startMs',0,'endMs',4000,'speakerId','S1','text','Petr: nebudeme nasazovat v pátek, počkáme na certifikát.'),
    jsonb_build_object('id','seg-1','startMs',4000,'endMs',9000,'speakerId','S2','text','Honza připraví migraci databáze do 25. listopadu.'),
    jsonb_build_object('id','seg-2','startMs',9000,'endMs',13000,'speakerId','S1','text','Rozhodli jsme, že release posuneme na pátek.'),
    jsonb_build_object('id','seg-3','startMs',13000,'endMs',15000,'speakerId','S2','text','Dobře, souhlasíme.'));
  m uuid; m2 uuid; run jsonb; items jsonb; r1 uuid; r2 uuid; req_a uuid; req_b uuid;
  n int; v_dec uuid; v_act uuid; v_ev jsonb;
  ev_neg jsonb := jsonb_build_array(jsonb_build_object('ref','segment:seg-0','quote','nebudeme nasazovat v pátek','quoteFound',true));
BEGIN
  PERFORM test.act_as(a, 'hd-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pH', 'Hardening');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('pH-col', 'pH', 'Todo', 0);
  PERFORM test.reset();
  INSERT INTO public.project_members (project_id, member_id) SELECT 'pH', id FROM public.workspace_members WHERE profile_id = b;
  PERFORM test.act_as(b, 'hd-b@example.test');
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pH', 'Porada H', 'text') RETURNING id INTO m;
  INSERT INTO public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count) VALUES (m, 'pH', rev1, 'paste', '[]', segs, 220);
  PERFORM test.reset(); -- the ledger is written by the server, not by members
  INSERT INTO public.ai_requests (user_id, project_id, feature, status) VALUES (b, 'pH', 'meeting-analyze', 'succeeded') RETURNING id INTO req_b;
  PERFORM test.act_as(b, 'hd-b@example.test');
  run := jsonb_build_object('status','succeeded','transcript_revision',rev1,'input_fingerprint','h1','contract_version','c','prompt_version','p1','validator_version','v','model','m','output',jsonb_build_object('summary','S'),'rejected_count',0);

  -- ================= SQL folding parity with the JS validator =================
  PERFORM test.ok(public.fold_text('  Rozhodli JSME, že…  Žluťoučký kůň!  ') = 'rozhodli jsme ze zlutoucky kun', 'fold_text: diacritics, case, punctuation, whitespace');
  PERFORM test.ok(public.quote_in_text('release posuneme na pátek', 'Rozhodli jsme, že release posuneme na pátek.'), 'quote_in_text: exact');
  PERFORM test.ok(public.quote_in_text('ROZHODLI jsme ze RELEASE', 'Rozhodli jsme, že release posuneme na pátek.'), 'quote_in_text: case/diacritics');
  PERFORM test.ok(NOT public.quote_in_text('budeme nasazovat v pátek', 'Petr: nebudeme nasazovat v pátek'), 'quote_in_text: "budeme" is NOT found inside "nebudeme" (whole words)');
  PERFORM test.ok(NOT public.quote_in_text('pátek release posuneme', 'Rozhodli jsme, že release posuneme na pátek.'), 'quote_in_text: reordered words are not found');
  PERFORM test.ok(public.quote_in_text('Rozhodli jsme … na pátek', 'Rozhodli jsme, že release posuneme na pátek.'), 'quote_in_text: "…" parts in order');
  PERFORM test.ok(NOT public.quote_in_text('na pátek … Rozhodli jsme', 'Rozhodli jsme, že release posuneme na pátek.'), 'quote_in_text: "…" parts out of order');
  PERFORM test.ok(NOT public.quote_in_text('jsme', 'Rozhodli jsme, že release'), 'quote_in_text: fewer than 2 words / 6 letters is not evidence');
  PERFORM test.ok(NOT public.quote_in_text('releasem', 'začneme releasem. Dobře'), 'quote_in_text: a single long word is not evidence');

  -- ================= evidence is recomputed by the database =================
  items := jsonb_build_array(
    jsonb_build_object('kind','risk','text','Riziko','support','linked','dedupe_key',repeat('1',64),
      'evidence',jsonb_build_array(jsonb_build_object('ref','segment:seg-1','quote','Honza zaplatí všechno zítra','quoteFound',true,'startMs',999,'endMs',1000))),
    jsonb_build_object('kind','decision','text','Posuneme release.','support','linked','dedupe_key',repeat('2',64),
      'evidence',jsonb_build_array(jsonb_build_object('ref','segment:seg-2','quote','release posuneme na pátek','quoteFound',true,'startMs',1,'endMs',2))),
    jsonb_build_object('kind','decision','text','Posuneme release (vymyšlená citace).','support','linked','dedupe_key',repeat('3',64),
      'evidence',jsonb_build_array(jsonb_build_object('ref','segment:seg-2','quote','release zrušíme úplně','quoteFound',true))),
    jsonb_build_object('kind','decision','text','Nasadíme v pátek.','support','linked','dedupe_key',repeat('4',64),
      'evidence',ev_neg || '[]'::jsonb),
    jsonb_build_object('kind','risk','text','Zápor před citací.','support','unverified','dedupe_key',repeat('5',64),
      'evidence',jsonb_build_array(jsonb_build_object('ref','segment:seg-0','quote','nebudeme nasazovat v pátek','quoteFound',true,'flag','negation_nearby'))),
    jsonb_build_object('kind','decision','text','Jen flag.','support','linked','dedupe_key',repeat('6',64),
      'evidence',jsonb_build_array(jsonb_build_object('ref','segment:seg-2','quote','release posuneme na pátek','quoteFound',true,'flag','negation_nearby'))),
    jsonb_build_object('kind','decision','text','Cross-segment.','support','linked','dedupe_key',repeat('7',64),
      'evidence',jsonb_build_array(jsonb_build_object('ref','segment:seg-2','quote','na pátek Dobře souhlasíme','quoteFound',true))));
  SELECT public.persist_meeting_run(m, jsonb_set(run, '{ai_request_id}', to_jsonb(req_b::text)), items, true) INTO r1;
  PERFORM test.ok((select count(*) from public.intelligence_items where run_id = r1) = 5, 'a run is stored; the decision whose quote is NOT in the transcript is skipped (not a failed run); flag-only decisions are skipped');
  PERFORM test.ok((select rejected_count from public.intelligence_runs where id = r1) = 2, 'skipped items are counted in rejected_count (invented quote, flag-only decision)');
  SELECT evidence INTO v_ev FROM public.intelligence_items WHERE run_id = r1 AND text = 'Riziko';
  PERFORM test.ok((v_ev -> 0 ->> 'quoteFound') = 'false' AND (select support from public.intelligence_items where run_id = r1 and text = 'Riziko') = 'unverified',
    'FORGED quoteFound=true for a quote that is not in the segment is corrected to false and the support to unverified');
  PERFORM test.ok((v_ev -> 0 ->> 'startMs') = '4000' AND (v_ev -> 0 ->> 'endMs') = '9000', 'times come from the stored segment, not from the client');
  PERFORM test.ok((select evidence -> 0 ->> 'startMs' from public.intelligence_items where run_id = r1 and text = 'Posuneme release.') = '9000', 'times corrected for linked items too');
  PERFORM test.ok((select support from public.intelligence_items where run_id = r1 and text = 'Posuneme release.') = 'linked', 'a genuinely found quote stays linked');
  PERFORM test.ok((select support from public.intelligence_items where run_id = r1 and text = 'Nasadíme v pátek.') = 'linked',
    'a whole-word quote that really exists is kept when the CLIENT did not flag it (the JS validator is the first line; the database checks the text, not the meaning)');
  PERFORM test.ok((select evidence -> 0 ->> 'flag' from public.intelligence_items where run_id = r1 and text = 'Zápor před citací.') = 'negation_nearby'
              AND (select support from public.intelligence_items where run_id = r1 and text = 'Zápor před citací.') = 'unverified', 'the negation flag is preserved and the item stays unverified');
  PERFORM test.ok((select count(*) from public.intelligence_items where run_id = r1 and text = 'Cross-segment.') = 1, 'a quote spanning the cited segment and the next one is found');
  PERFORM test.ok((select ai_request_id from public.intelligence_runs where id = r1) = req_b, 'provenance link to the caller''s own ledger row is kept');
  PERFORM test.reset();
  INSERT INTO public.ai_requests (user_id, project_id, feature, status) VALUES (a, 'pH', 'meeting-analyze', 'succeeded') RETURNING id INTO req_a;
  PERFORM test.act_as(b, 'hd-b@example.test');
  PERFORM test.throws(format($q$select public.persist_meeting_run(%L, %L::jsonb, '[]'::jsonb, true)$q$, m, jsonb_set(run, '{ai_request_id}', to_jsonb(req_a::text))::text), '42501', 'another user''s ledger row cannot be attached as provenance');

  -- ================= approved knowledge survives re-analysis (P1-4) =================
  SELECT id INTO v_dec FROM public.intelligence_items WHERE run_id = r1 AND text = 'Posuneme release.';
  SELECT id INTO v_act FROM public.intelligence_items WHERE run_id = r1 AND text = 'Riziko';
  PERFORM public.review_intelligence_item(v_dec, 'accept');
  PERFORM public.review_intelligence_item(v_act, 'reject');
  SELECT public.persist_meeting_run(m, jsonb_set(run, '{input_fingerprint}', '"h2"'), jsonb_build_array(jsonb_build_object('kind','decision','text','Posuneme release (nová analýza).','support','linked','dedupe_key',repeat('2',64),
     'evidence',jsonb_build_array(jsonb_build_object('ref','segment:seg-2','quote','release posuneme na pátek','quoteFound',true)))), true) INTO r2;
  PERFORM test.ok((select review_state from public.intelligence_items where id = v_dec) = 'accepted', 'RE-ANALYSIS DOES NOT SUPERSEDE AN ACCEPTED ITEM');
  PERFORM test.ok((select superseded_at is not null from public.intelligence_runs where id = r1), 'the old run itself is superseded');
  PERFORM test.ok((select review_state from public.intelligence_items where id = v_act) = 'superseded', 'a REJECTED item of the old run is replaced');
  PERFORM test.ok((select count(*) from public.intelligence_items where run_id = r1 and review_state = 'proposed') = 0, 'open suggestions of the old run are replaced');
  PERFORM test.ok((select duplicate_of from public.intelligence_items where run_id = r2) = v_dec, 'the new item is flagged as a possible duplicate of the ACCEPTED one (the human sees both)');
  PERFORM public.review_intelligence_item(v_dec, 'reject');
  PERFORM test.ok((select review_state from public.intelligence_items where id = v_dec) = 'rejected', 'explicit revocation: a human can withdraw an accepted item');
  PERFORM public.review_intelligence_item(v_dec, 'reopen');
  PERFORM public.review_intelligence_item(v_dec, 'accept');

  -- ================= current revision is never rewound =================
  INSERT INTO public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, char_count, parent_revision)
    VALUES (m, 'pH', rev2, 'edit', '[]', segs, 220, rev1);
  PERFORM test.ok((select current_revision from public.meetings where id = m) = rev2, 'edit became the current revision');
  PERFORM public.persist_meeting_run(m, jsonb_set(run, '{input_fingerprint}', '"h3"'), '[]'::jsonb, true);
  PERFORM test.ok((select current_revision from public.meetings where id = m) = rev2, 'analysing an OLDER revision does not rewind current_revision');
  PERFORM test.ok((select status from public.meetings where id = m) <> 'ready', 'and does not mark the meeting "ready" while a newer revision exists');

  -- ================= decision metadata and applied card cannot be forged =================
  PERFORM test.throws(format($q$update public.intelligence_items set decided_by = %L where id = %L$q$, a, v_dec), '42501', 'decided_by cannot be written directly');
  PERFORM test.throws(format($q$update public.intelligence_items set decided_at = now() - interval '1 year' where id = %L$q$, v_dec), '42501', 'decided_at cannot be backdated');
  PERFORM public.review_intelligence_item(v_dec, 'reject');
  UPDATE public.intelligence_items SET review_state = 'proposed', decided_by = a WHERE id = v_dec;
  PERFORM test.ok((select decided_by = b from public.intelligence_items where id = v_dec), 'on a state change the database sets decided_by to the CALLER, whatever the client wrote');
  UPDATE public.intelligence_items SET review_state = 'accepted' WHERE id = v_dec;
  PERFORM test.throws(format($q$update public.intelligence_items set applied_card_id = null, applied_mode = 'create_card' where id = %L$q$, v_dec), '55000', 'an accepted item cannot carry an applied mode');

  -- ================= meeting deletion needs CURRENT membership =================
  PERFORM test.reset();
  DELETE FROM public.project_members WHERE project_id = 'pH' AND member_id IN (SELECT id FROM public.workspace_members WHERE profile_id = b);
  PERFORM test.act_as(b, 'hd-b@example.test');
  DELETE FROM public.meetings WHERE id = m; GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'a REMOVED member cannot delete the meeting they created (even with an unfiltered DELETE)');
  PERFORM test.act_as(c, 'hd-c@example.test');
  PERFORM test.ok((select count(*) from public.intelligence_items) = 0, 'a stranger still sees no items');
END $$;
