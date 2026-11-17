#!/usr/bin/env bash
# Real parallel connections: 12 simultaneous ai_reserve() calls by ONE user with a
# limit of 5/minute must yield exactly 5 allowed reservations (no limit bypass).
# Sourced by run.sh.
db=cs_a
echo "== Concurrency: parallel reservations cannot bypass the rate limit"
UID_=$(psql_admin -d "$db" -At -c "select test.mkuser('parallel@example.test')" | tail -1)
out=$(mktemp -d)
for i in $(seq 1 12); do
  (
    psql_admin -d "$db" -At -f - <<SQL > "$out/$i.txt" 2>&1
select set_config('request.jwt.claims', '{"sub":"$UID_","email":"parallel@example.test","role":"authenticated"}', false);
set role authenticated;
select allowed::text || ':' || coalesce(reason,'') from public.ai_reserve('chat', NULL, 10, 5, 1000, 100000);
SQL
  ) &
done
wait
allowed=$(cat "$out"/*.txt | grep -c '^true:' || true)
limited=$(cat "$out"/*.txt | grep -c '^false:rate_limited' || true)
rows=$(psql_admin -d "$db" -At -c "select count(*) from public.ai_requests where user_id='$UID_'" | tail -1)
rm -rf "$out"
echo "allowed=$allowed rate_limited=$limited ledger_rows=$rows (12 parallel requests, limit 5)"
[ "$allowed" = "5" ] && [ "$limited" = "7" ] && [ "$rows" = "5" ] || { echo "FAIL: concurrency"; exit 1; }
echo "ok - exactly 5 reservations passed under 12-way concurrency"
