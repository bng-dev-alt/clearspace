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

# --- Intelligence core: persisting a run and applying an item are exactly-once under parallel calls ---
echo "== Concurrency: parallel persist_meeting_run / apply_intelligence_item are exactly-once"
U2=$(psql_admin -d "$db" -At -c "select test.mkuser('par2@example.test')" | tail -1)
AUTH="select set_config('request.jwt.claims', '{\"sub\":\"$U2\",\"email\":\"par2@example.test\",\"role\":\"authenticated\"}', false); set role authenticated;"
REV=$(printf 'c%.0s' $(seq 1 64)); DK=$(printf 'd%.0s' $(seq 1 64))
MID=$(psql_admin -d "$db" -At <<SQL | tail -1
$AUTH
insert into public.projects (id, name) values ('par-p', 'Parallel');
insert into public.columns (id, project_id, name, position) values ('par-c', 'par-p', 'Todo', 0);
with m as (insert into public.meetings (project_id, title, source_kind) values ('par-p', 'Par', 'text') returning id)
insert into public.meeting_transcripts (meeting_id, project_id, revision, source, segments, char_count)
  select id, 'par-p', '$REV', 'paste', '[{"id":"seg-0","text":"Udělat X teď určitě."}]'::jsonb, 20 from m;
select id from public.meetings where project_id = 'par-p';
SQL
)
RUN="'{\"status\":\"succeeded\",\"transcript_revision\":\"$REV\",\"input_fingerprint\":\"f\",\"contract_version\":\"c\",\"prompt_version\":\"p1\",\"validator_version\":\"v\",\"output\":{\"summary\":\"s\"}}'::jsonb"
ITEMS="'[{\"kind\":\"action_item\",\"text\":\"Udělat X.\",\"support\":\"linked\",\"evidence\":[{\"ref\":\"segment:seg-0\",\"quote\":\"Udělat X teď\",\"quoteFound\":true}],\"dedupe_key\":\"$DK\"}]'::jsonb"
out2=$(mktemp -d)
for i in $(seq 1 8); do
  ( psql_admin -d "$db" -At -f - <<SQL > "$out2/p$i.txt" 2>&1
$AUTH
select public.persist_meeting_run('$MID', $RUN, $ITEMS);
SQL
  ) &
done
wait
persisted=$(cat "$out2"/p*.txt | grep -cE '^[0-9a-f]{8}-[0-9a-f]{4}-' || true)
refused=$(cat "$out2"/p*.txt | grep -c 'už byla analyzována' || true)
runs=$(psql_admin -d "$db" -At -c "select count(*) from public.intelligence_runs where meeting_id = '$MID'" | tail -1)
echo "persisted=$persisted refused_as_duplicate=$refused runs=$runs (8 parallel identical requests)"
[ "$persisted" = "1" ] && [ "$refused" = "7" ] && [ "$runs" = "1" ] || { echo "FAIL: parallel persist is not exactly-once"; exit 1; }
echo "ok - exactly one run was stored under 8-way concurrency"

ITEM=$(psql_admin -d "$db" -At -c "select id from public.intelligence_items where meeting_id = '$MID'" | tail -1)
for i in $(seq 1 8); do
  ( psql_admin -d "$db" -At -f - <<SQL > "$out2/a$i.txt" 2>&1
$AUTH
select public.apply_intelligence_item('$ITEM', '{"mode":"create_card","column_id":"par-c","title":"Par card"}'::jsonb);
SQL
  ) &
done
wait
created=$(cat "$out2"/a*.txt | grep -c '"already_applied": false' || true)
repeats=$(cat "$out2"/a*.txt | grep -c '"already_applied": true' || true)
cards=$(psql_admin -d "$db" -At -c "select count(*) from public.cards where column_id = 'par-c'" | tail -1)
logs=$(psql_admin -d "$db" -At -c "select count(*) from public.activity_logs where project_id = 'par-p' and action_type = 'card_created'" | tail -1)
rm -rf "$out2"
echo "created=$created repeats=$repeats cards=$cards activity_logs=$logs (8 parallel approvals of one item)"
[ "$created" = "1" ] && [ "$repeats" = "7" ] && [ "$cards" = "1" ] && [ "$logs" = "1" ] || { echo "FAIL: parallel approval is not exactly-once"; exit 1; }
echo "ok - exactly one card was created under 8-way concurrent approval"

# --- Meeting audio: starting and completing a transcription are exactly-once under parallel calls ---
echo "== Concurrency: parallel stt_reserve / stt_complete are exactly-once (no double submission, no double billing)"
AM=$(psql_admin -d "$db" -At <<SQL | tail -1
$AUTH
insert into public.meetings (project_id, title, source_kind) values ('par-p', 'Audio par', 'audio');
select public.record_audio_consent(id) from public.meetings where title = 'Audio par';
select id from public.meetings where title = 'Audio par';
SQL
)
SEC=$(printf 's%.0s' $(seq 1 40))
psql_admin -d "$db" -At >/dev/null -c "insert into public.server_trust (purpose, secret_sha256) values ('stt', encode(sha256(convert_to('$SEC', 'UTF8')), 'hex'))"
APATH="par-p/$AM/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp3"
psql_admin -d "$db" -At >/dev/null <<SQL
$AUTH
insert into storage.objects (bucket_id, name, owner, metadata) values ('meeting-audio', '$APATH', '$U2', '{"size":1000}');
select public.attach_meeting_audio('$AM', '$APATH', 1000, 'audio/mpeg', 60000);
SQL
out3=$(mktemp -d)
for i in $(seq 1 8); do
  ( psql_admin -d "$db" -At -f - <<SQL > "$out3/s$i.txt" 2>&1
$AUTH
select outcome from public.stt_reserve('$SEC', '$AM', 60000, 7200000, 36000000);
SQL
  ) &
done
wait
started=$(cat "$out3"/s*.txt | grep -c '^started$' || true)
inprog=$(cat "$out3"/s*.txt | grep -c '^in_progress$' || true)
ledger=$(psql_admin -d "$db" -At -c "select count(*) from public.ai_requests where feature = 'meeting-transcribe' and user_id = '$U2'" | tail -1)
echo "started=$started in_progress=$inprog ledger_rows=$ledger (8 parallel start requests)"
[ "$started" = "1" ] && [ "$inprog" = "7" ] && [ "$ledger" = "1" ] || { echo "FAIL: parallel start is not exactly-once"; exit 1; }
echo "ok - exactly one transcription was started under 8-way concurrency"

psql_admin -d "$db" -At >/dev/null <<SQL
$AUTH
select public.stt_attach_job('$SEC', '$AM', 'job-par', 'stt-async-v6');
SQL
TREV=$(printf 'e%.0s' $(seq 1 64))
TR="'{\"revision\":\"$TREV\",\"char_count\":20,\"speakers\":[],\"segments\":[{\"id\":\"seg-0-0\",\"startMs\":0,\"endMs\":1000,\"speakerId\":null,\"text\":\"Ahoj světe tady.\"}],\"coverage\":{}}'::jsonb"
for i in $(seq 1 8); do
  ( psql_admin -d "$db" -At -f - <<SQL > "$out3/c$i.txt" 2>&1
$AUTH
select public.stt_complete('$SEC', '$AM', 'job-par', 'stt-async-v6', 60000, $TR);
SQL
  ) &
done
wait
same=$(cat "$out3"/c*.txt | grep -c "^$TREV\$" || true)
trs=$(psql_admin -d "$db" -At -c "select count(*) from public.meeting_transcripts where meeting_id = '$AM'" | tail -1)
billed=$(psql_admin -d "$db" -At -c "select coalesce(sum(audio_ms),0) from public.ai_requests where feature = 'meeting-transcribe' and status = 'succeeded' and user_id = '$U2'" | tail -1)
rm -rf "$out3"
echo "same_revision_answers=$same transcripts=$trs billed_ms=$billed (8 parallel completions of one job)"
[ "$same" = "8" ] && [ "$trs" = "1" ] && [ "$billed" = "60000" ] || { echo "FAIL: parallel completion is not exactly-once"; exit 1; }
echo "ok - the transcript was stored and billed once under 8-way concurrent completion"

# --- Approved knowledge: an accept racing against forced re-analyses can never end as accepted -> superseded ---
echo "== Concurrency: accepting an item while the meeting is re-analysed in parallel never loses an accepted item"
RUNB="'{\"status\":\"succeeded\",\"transcript_revision\":\"$REV\",\"input_fingerprint\":\"fr\",\"contract_version\":\"c\",\"prompt_version\":\"p1\",\"validator_version\":\"v\",\"output\":{\"summary\":\"s\"}}'::jsonb"
out4=$(mktemp -d)
for round in 1 2 3; do
  # a fresh proposed item to accept in every round (forced re-analysis supersedes the previous round's open items)
  psql_admin -d "$db" -At >/dev/null <<SQL
$AUTH
select public.persist_meeting_run('$MID', $RUNB, $ITEMS, true);
SQL
  CAND=$(psql_admin -d "$db" -At -c "select id from public.intelligence_items where meeting_id = '$MID' and review_state = 'proposed' order by created_at desc limit 1" | tail -1)
  ( psql_admin -d "$db" -At -f - <<SQL > "$out4/acc$round.txt" 2>&1
$AUTH
select public.review_intelligence_item('$CAND', 'accept');
SQL
  ) &
  for i in 1 2 3; do
    ( psql_admin -d "$db" -At -f - <<SQL > "$out4/re$round-$i.txt" 2>&1
$AUTH
select public.persist_meeting_run('$MID', $RUNB, $ITEMS, true);
SQL
    ) &
  done
  wait
  accepted_ok=$(grep -c '"review_state": "accepted"' "$out4/acc$round.txt" || true)
  final=$(psql_admin -d "$db" -At -c "select review_state from public.intelligence_items where id = '$CAND'" | tail -1)
  if [ "$accepted_ok" != "0" ] && [ "$final" != "accepted" ] && [ "$final" != "applied" ]; then echo "FAIL: item $CAND was accepted by a human but ended as '$final' after re-analysis"; exit 1; fi
  echo "round $round: accept succeeded=$accepted_ok final_state=$final"
done
rm -rf "$out4"
echo "ok - an item a human accepted was never superseded by a concurrent re-analysis"
