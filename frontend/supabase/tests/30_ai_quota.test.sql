-- AI ledger: authorization, atomic reservation, limits, tamper resistance.
DO $$
DECLARE
  a uuid := test.mkuser('ai-a@example.test');
  b uuid := test.mkuser('ai-b@example.test');
  r record;
  r2 record;
  n int;
BEGIN
  PERFORM test.act_as(a, 'ai-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('aiA', 'AI A');

  -- allowed + project authorization
  SELECT * INTO r FROM public.ai_reserve('improve', 'aiA', 500, 10, 100, 10000);
  PERFORM test.ok(r.allowed AND r.request_id IS NOT NULL AND r.reason IS NULL, 'member can reserve for own project');
  PERFORM test.ok((select status from public.ai_requests where id = r.request_id) = 'reserved', 'row is reserved BEFORE any provider call');

  PERFORM test.act_as(b, 'ai-b@example.test');
  SELECT * INTO r2 FROM public.ai_reserve('improve', 'aiA', 500, 10, 100, 10000);
  PERFORM test.ok(NOT r2.allowed AND r2.reason = 'forbidden', 'non-member is forbidden for foreign project');
  PERFORM test.ok((select count(*) from public.ai_requests) = 0, 'B sees no ledger rows (and none were created for the forbidden call)');
  SELECT * INTO r2 FROM public.ai_reserve('improve', 'does-not-exist', 500, 10, 100, 10000);
  PERFORM test.ok(NOT r2.allowed AND r2.reason = 'forbidden', 'unknown project id is forbidden, not an error oracle');

  -- ledger is not writable by clients
  PERFORM test.throws($q$insert into public.ai_requests (user_id, feature) values (auth.uid(), 'x')$q$, '42501', 'client cannot INSERT ledger rows');
  PERFORM test.throws($q$update public.ai_requests set reserved_tokens = 0$q$, '42501', 'client cannot UPDATE ledger rows');
  PERFORM test.throws($q$delete from public.ai_requests$q$, '42501', 'client cannot DELETE ledger rows');

  -- A cannot see B's rows and vice versa
  PERFORM test.act_as(b, 'ai-b@example.test');
  SELECT * INTO r2 FROM public.ai_reserve('chat', NULL, 100, 10, 100, 10000);
  PERFORM test.act_as(a, 'ai-a@example.test');
  PERFORM test.ok((select count(*) from public.ai_requests) = 1, 'A sees only own ledger rows');

  -- completion: only the owner, only once, only valid statuses
  PERFORM test.act_as(b, 'ai-b@example.test');
  PERFORM public.ai_complete(r.request_id, 'succeeded', 'm', 1, 1, NULL, 1);   -- B tries to complete A's row
  PERFORM test.reset();
  PERFORM test.ok((select status from public.ai_requests where id = r.request_id) = 'reserved', 'B cannot complete A''s request');
  PERFORM test.act_as(a, 'ai-a@example.test');
  PERFORM public.ai_complete(r.request_id, 'succeeded', 'gemini-test', 120, 80, NULL, 900);
  PERFORM test.ok((select total_tokens from public.ai_requests where id = r.request_id) = 200, 'completion records usage');
  PERFORM public.ai_complete(r.request_id, 'failed', 'x', 0, 0, 'late', 1);
  PERFORM test.ok((select status from public.ai_requests where id = r.request_id) = 'succeeded', 'a completed request cannot be re-completed');
  PERFORM test.throws($q$select public.ai_complete(gen_random_uuid(), 'bogus', 'm', 1, 1, NULL, 1)$q$, '22023', 'invalid completion status rejected');

  -- invalid parameters
  PERFORM test.throws($q$select * from public.ai_reserve('', NULL, 1, 10, 100, 1000)$q$, '22023', 'empty feature rejected');
  PERFORM test.throws($q$select * from public.ai_reserve('x', NULL, -5, 10, 100, 1000)$q$, '22023', 'negative reservation rejected');
  PERFORM test.throws($q$select * from public.ai_reserve('x', NULL, 1, 0, 100, 1000)$q$, '22023', 'zero limit rejected');
  PERFORM test.act_as_anon();
  PERFORM test.throws($q$select * from public.ai_reserve('x', NULL, 1, 10, 100, 1000)$q$, '42501', 'anon cannot reserve');
  PERFORM test.throws($q$select public.ai_complete(gen_random_uuid(), 'failed', 'm', 1, 1, NULL, 1)$q$, '42501', 'anon cannot complete');
END $$;

-- Per-user rate limit (fresh users so counts are exact)
select test.reset();
DO $$
DECLARE u uuid := test.mkuser('ai-rate@example.test'); r record; ok_count int := 0;
BEGIN
  PERFORM test.act_as(u, 'ai-rate@example.test');
  FOR i IN 1..3 LOOP
    SELECT * INTO r FROM public.ai_reserve('chat', NULL, 10, 3, 1000, 100000);
    IF r.allowed THEN ok_count := ok_count + 1; END IF;
  END LOOP;
  PERFORM test.ok(ok_count = 3, 'first 3 requests allowed at limit 3/min');
  SELECT * INTO r FROM public.ai_reserve('chat', NULL, 10, 3, 1000, 100000);
  PERFORM test.ok(NOT r.allowed AND r.reason = 'rate_limited', '4th request is rate_limited');
EXCEPTION WHEN OTHERS THEN PERFORM test.reset(); RAISE;
END $$;

-- Global limit across accounts
select test.reset();
DO $$
DECLARE g1 uuid := test.mkuser('g1@example.test'); g2 uuid := test.mkuser('g2@example.test'); r record; before_n int;
BEGIN
  PERFORM test.reset();
  before_n := (SELECT count(*) FROM public.ai_requests WHERE created_at > now() - interval '1 minute');
  PERFORM test.act_as(g1, 'g1@example.test');
  SELECT * INTO r FROM public.ai_reserve('chat', NULL, 1, 100, before_n + 1, 100000);
  PERFORM test.ok(r.allowed, 'first account fits under the global limit');
  PERFORM test.act_as(g2, 'g2@example.test');
  SELECT * INTO r FROM public.ai_reserve('chat', NULL, 1, 100, before_n + 1, 100000);
  PERFORM test.ok(NOT r.allowed AND r.reason = 'global_rate_limited', 'a different account is stopped by the GLOBAL limit');
EXCEPTION WHEN OTHERS THEN PERFORM test.reset(); RAISE;
END $$;

-- Daily token budget + tamper resistance
select test.reset();
DO $$
DECLARE u uuid := test.mkuser('ai-budget@example.test'); r record; r2 record;
BEGIN
  PERFORM test.act_as(u, 'ai-budget@example.test');
  SELECT * INTO r FROM public.ai_reserve('chat', NULL, 600, 100, 100000, 1000);
  PERFORM test.ok(r.allowed, 'reserve 600 of a 1000 budget');
  -- caller under-reports usage as 0 -- the reservation must still count
  PERFORM public.ai_complete(r.request_id, 'succeeded', 'm', 0, 0, NULL, 1);
  SELECT * INTO r2 FROM public.ai_reserve('chat', NULL, 600, 100, 100000, 1000);
  PERFORM test.ok(NOT r2.allowed AND r2.reason = 'budget_exceeded', 'under-reporting usage does not free budget');
  SELECT * INTO r2 FROM public.ai_reserve('chat', NULL, 400, 100, 100000, 1000);
  PERFORM test.ok(r2.allowed, 'remaining budget is still usable');
EXCEPTION WHEN OTHERS THEN PERFORM test.reset(); RAISE;
END $$;
