-- READ-ONLY verification of migrations 0500-0700 (and optionally 0800) on a hosted/restored database. Metadata and counts only.
--   psql "$DB_URL" -X -f frontend/supabase/verify_hosted_intelligence.sql
-- Every line that starts with "GATE" must say PASS. Read-only is enforced by the first statement (the Supabase pooler drops
-- startup options, so PGOPTIONS would silently do nothing there).
SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;
\pset tuples_only on
\pset format unaligned
\echo == read-only session
show transaction_read_only;

select 'GATE markers 0100-0400 + 0500-0700 present, no 0800 needed on a fresh history: ' ||
       case when (select count(*) from public.clearspace_migrations where version in (
            '20261117000100_security_foundation','20261117000200_restore_project_board','20261117000300_least_privilege_table_grants',
            '20261117000400_task_resources_storage','20261118000500_intelligence_core','20261118000600_intelligence_quality',
            '20261118000700_meeting_audio')) = 7 then 'PASS' else 'FAIL' end;
select 'INFO markers: ' || string_agg(version, ', ' order by version) from public.clearspace_migrations;

select 'GATE hotfix 0900 (account erasure): marker present, guard_meeting_identity is SECURITY DEFINER with a pinned search_path and carries the erasure exemption: ' ||
       case when exists (select 1 from public.clearspace_migrations where version = '20261118000900_meeting_creator_erasure')
             and exists (select 1 from pg_proc p where p.oid = 'public.guard_meeting_identity()'::regprocedure and p.prosecdef
                         and coalesce(p.proconfig::text, '') like '%search_path%' and pg_get_functiondef(p.oid) like '%public.profiles%')
            then 'PASS' else 'FAIL' end;

select 'GATE new tables exist and have RLS on (8 expected): ' ||
       case when count(*) = 8 and bool_and(c.relrowsecurity) then 'PASS' else 'FAIL (' || count(*) || ' found)' end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and c.relname in ('meetings','meeting_transcripts','intelligence_runs','intelligence_items','stt_jobs','server_trust','meeting_audio_orphans','machine_persist_tokens');

select 'GATE anon holds no privilege on the new tables: ' ||
       case when count(*) = 0 then 'PASS' else 'FAIL (' || count(*) || ')' end
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee = 'anon'
   and table_name in ('meetings','meeting_transcripts','intelligence_runs','intelligence_items','stt_jobs','server_trust','meeting_audio_orphans','machine_persist_tokens');

select 'GATE authenticated has NO privilege on server_trust / machine_persist_tokens and no INSERT on intelligence_items/runs, stt_jobs, ai_requests: ' ||
       case when count(*) = 0 then 'PASS' else 'FAIL: ' || string_agg(table_name || ':' || privilege_type, ', ') end
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee = 'authenticated'
   and ((table_name in ('server_trust','machine_persist_tokens'))
        or (table_name in ('intelligence_items','intelligence_runs','stt_jobs','ai_requests') and privilege_type in ('INSERT','UPDATE','DELETE')));

select 'GATE every SECURITY DEFINER function in public pins its search_path: ' ||
       case when count(*) = 0 then 'PASS' else 'FAIL: ' || string_agg(p.oid::regprocedure::text, ', ') end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');

select 'GATE the only public functions executable by anon/PUBLIC are the 4 known pure or by-design ones: ' ||
       case when coalesce(string_agg(p.proname, ',' order by p.proname), '') = 'fold_text,intelligence_limits,invitation_preview,quote_in_text' then 'PASS' else 'FAIL: ' || coalesce(string_agg(p.oid::regprocedure::text, ', '), '') end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'));

select 'GATE no secret-less (obsolete) stt_* function exists, and every stt_* takes p_server_secret first: ' ||
       case when count(*) = 0 then 'PASS' else 'FAIL: ' || string_agg(p.oid::regprocedure::text, ', ') end
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'stt\_%' and (p.proargnames is null or p.proargnames[1] is distinct from 'p_server_secret');

select 'GATE no server secret hash is registered yet (audio stays fail-closed until the owner step): ' ||
       case when (select count(*) from public.server_trust) = 0 then 'PASS' else 'NOTE: a hash is registered' end;

select 'GATE bucket meeting-audio is private, 50 MiB, audio-only MIME list; 3 meeting_audio_* policies: ' ||
       case when (select count(*) from storage.buckets where id = 'meeting-audio' and public = false and file_size_limit = 52428800
                  and not exists (select 1 from unnest(allowed_mime_types) m where m !~ '^audio/')) = 1
             and (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'meeting\_audio\_%') = 3
            then 'PASS' else 'FAIL' end;

select 'GATE no meetings / audio / jobs yet (nothing is enabled): ' ||
       case when (select count(*) from public.meetings) = 0 and (select count(*) from public.stt_jobs) = 0
             and (select count(*) from storage.objects where bucket_id = 'meeting-audio') = 0 then 'PASS' else 'NOTE: rows exist' end;

select 'INFO old-table counts: ' || 'profiles=' || (select count(*) from public.profiles) || ' projects=' || (select count(*) from public.projects)
       || ' columns=' || (select count(*) from public.columns) || ' cards=' || (select count(*) from public.cards)
       || ' workspace_members=' || (select count(*) from public.workspace_members) || ' invitations=' || (select count(*) from public.invitations)
       || ' ai_requests=' || (select count(*) from public.ai_requests) || ' auth.users=' || (select count(*) from auth.users);
