-- ============================================================
-- 20261118000600 -- Intelligence quality (R6): column roles, transcript revision lineage, meeting quotas,
--                   project freshness stamp
--
-- ADDITIVE and idempotent. Apply after 20261118000500_intelligence_core. No existing row is deleted; the only
-- data change is the one-time backfill of `columns.role` where it is still NULL.
--
--  * columns.role: explicit semantic role (todo / doing / review / done) so facts never depend on column NAMES alone.
--    NULL = "not set" (the app then falls back to the old name heuristic). Backfilled from names once.
--  * meeting_transcripts: `parent_revision` + `edit_note` + source 'edit' = a readable revision history; revisions stay
--    immutable. A per-meeting revision quota is enforced by a trigger.
--  * meetings: creation quota per project and per user per day (storage-abuse guard) enforced by a trigger.
--  * project_intelligence_stamp(project): one deterministic fingerprint of everything the Project Brief is derived from
--    (cards, comments, checklists, assignees, activity, accepted knowledge, transcript revisions). SECURITY INVOKER,
--    so RLS decides what the caller can count.
-- ============================================================

DO $$
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261118000500_intelligence_core') THEN
        RAISE EXCEPTION 'Preflight failed -- apply 20261118000500_intelligence_core first. Nothing was changed.';
    END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Column roles
-- ------------------------------------------------------------
ALTER TABLE public.columns ADD COLUMN IF NOT EXISTS role TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'columns_role_check' AND conrelid = 'public.columns'::regclass) THEN
        ALTER TABLE public.columns
            ADD CONSTRAINT columns_role_check CHECK (role IS NULL OR role IN ('todo', 'doing', 'review', 'done'));
    END IF;
END $$;

-- One-time backfill from names (only rows that have no role yet; never overwrites a human choice).
UPDATE public.columns SET role = CASE
        WHEN name ~* '(hotovo|done|dokon|complete)' THEN 'done'
        WHEN name ~* '(reviz|review|kontrol|testov)' THEN 'review'
        WHEN name ~* '(prob[ií]h|rozpracov|doing|progress|vývoj|vyvoj)' THEN 'doing'
        WHEN name ~* '(to ?do|k řešení|k reseni|backlog|nové|nove|plán)' THEN 'todo'
        ELSE NULL END
 WHERE role IS NULL;

-- ------------------------------------------------------------
-- 2. Transcript revision lineage
-- ------------------------------------------------------------
ALTER TABLE public.meeting_transcripts ADD COLUMN IF NOT EXISTS parent_revision TEXT;
ALTER TABLE public.meeting_transcripts ADD COLUMN IF NOT EXISTS edit_note TEXT;

DO $$
DECLARE
    v_def TEXT;
BEGIN
    -- 'edit' = a human edited an earlier revision (new immutable revision, the parent stays readable).
    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conrelid = 'public.meeting_transcripts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%source%paste%';
    IF v_def IS NOT NULL AND v_def NOT ILIKE '%''edit''%' THEN
        EXECUTE (SELECT format('ALTER TABLE public.meeting_transcripts DROP CONSTRAINT %I', conname) FROM pg_constraint
                  WHERE conrelid = 'public.meeting_transcripts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%source%paste%' LIMIT 1);
        ALTER TABLE public.meeting_transcripts
            ADD CONSTRAINT meeting_transcripts_source_check CHECK (source IN ('paste', 'txt', 'md', 'vtt', 'srt', 'soniox', 'edit'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_transcripts_edit_note_check') THEN
        ALTER TABLE public.meeting_transcripts
            ADD CONSTRAINT meeting_transcripts_edit_note_check CHECK (edit_note IS NULL OR char_length(edit_note) <= 500);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_transcripts_parent_fk') THEN
        ALTER TABLE public.meeting_transcripts
            ADD CONSTRAINT meeting_transcripts_parent_fk FOREIGN KEY (meeting_id, parent_revision)
            REFERENCES public.meeting_transcripts (meeting_id, revision) ON DELETE CASCADE;
    END IF;
END $$;

GRANT INSERT (parent_revision, edit_note) ON public.meeting_transcripts TO authenticated;

-- Limits live in ONE place so tests, docs and the app agree.
CREATE OR REPLACE FUNCTION public.intelligence_limits()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'max_meetings_per_project', 500,
        'max_meetings_per_user_per_day', 40,
        'max_revisions_per_meeting', 25
    );
$$;
GRANT EXECUTE ON FUNCTION public.intelligence_limits() TO authenticated;

CREATE OR REPLACE FUNCTION public.validate_transcript_lineage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_max INTEGER := (public.intelligence_limits() ->> 'max_revisions_per_meeting')::integer;
BEGIN
    IF NEW.source = 'edit' AND NEW.parent_revision IS NULL THEN
        RAISE EXCEPTION 'Úprava přepisu musí odkazovat na původní revizi.' USING ERRCODE = '22023';
    END IF;
    IF NEW.parent_revision IS NOT NULL AND NEW.parent_revision = NEW.revision THEN
        RAISE EXCEPTION 'Revize nemůže být svým vlastním předchůdcem.' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM public.meeting_transcripts WHERE meeting_id = NEW.meeting_id) >= v_max THEN
        RAISE EXCEPTION 'Porada má maximální počet revizí přepisu (%).', v_max USING ERRCODE = 'PT429';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_transcript_lineage() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meeting_transcripts_lineage ON public.meeting_transcripts;
CREATE TRIGGER meeting_transcripts_lineage BEFORE INSERT ON public.meeting_transcripts
    FOR EACH ROW EXECUTE FUNCTION public.validate_transcript_lineage();

-- ------------------------------------------------------------
-- 3. Meeting creation quota
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_meeting_quota()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lim JSONB := public.intelligence_limits();
BEGIN
    -- Serialise concurrent creates of the same project so the count cannot be raced past the limit.
    PERFORM pg_advisory_xact_lock(hashtextextended('meeting_quota:' || NEW.project_id, 0));
    IF (SELECT count(*) FROM public.meetings WHERE project_id = NEW.project_id) >= (v_lim ->> 'max_meetings_per_project')::integer THEN
        RAISE EXCEPTION 'Projekt dosáhl maximálního počtu porad.' USING ERRCODE = 'PT429';
    END IF;
    IF NEW.created_by IS NOT NULL AND
       (SELECT count(*) FROM public.meetings WHERE created_by = NEW.created_by AND created_at > now() - interval '1 day')
         >= (v_lim ->> 'max_meetings_per_user_per_day')::integer THEN
        RAISE EXCEPTION 'Dosáhli jste denního limitu vytvořených porad.' USING ERRCODE = 'PT429';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_meeting_quota() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meetings_quota ON public.meetings;
CREATE TRIGGER meetings_quota BEFORE INSERT ON public.meetings
    FOR EACH ROW EXECUTE FUNCTION public.enforce_meeting_quota();

-- ------------------------------------------------------------
-- 4. Project freshness stamp
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.project_intelligence_stamp(p_project_id TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT md5(concat_ws('|',
        'stamp-1',
        (SELECT concat_ws(',', count(*), count(*) FILTER (WHERE c.archived), coalesce(extract(epoch FROM max(c.updated_at))::text, ''))
           FROM public.cards c JOIN public.columns col ON col.id = c.column_id WHERE col.project_id = p_project_id),
        (SELECT coalesce(string_agg(col.id || ':' || col.position || ':' || coalesce(col.role, ''), ',' ORDER BY col.id), '')
           FROM public.columns col WHERE col.project_id = p_project_id),
        (SELECT concat_ws(',', count(*), coalesce(extract(epoch FROM max(tc.created_at))::text, ''))
           FROM public.task_comments tc JOIN public.cards c ON c.id = tc.card_id JOIN public.columns col ON col.id = c.column_id
          WHERE col.project_id = p_project_id),
        (SELECT concat_ws(',', count(*), count(*) FILTER (WHERE ch.completed))
           FROM public.task_checklists ch JOIN public.cards c ON c.id = ch.card_id JOIN public.columns col ON col.id = c.column_id
          WHERE col.project_id = p_project_id),
        (SELECT coalesce(md5(string_agg(ca.card_id || ':' || ca.member_id, ',' ORDER BY ca.card_id, ca.member_id)), '')
           FROM public.card_assignees ca JOIN public.cards c ON c.id = ca.card_id JOIN public.columns col ON col.id = c.column_id
          WHERE col.project_id = p_project_id),
        (SELECT concat_ws(',', count(*), coalesce(extract(epoch FROM max(a.created_at))::text, ''))
           FROM public.activity_logs a WHERE a.project_id = p_project_id),
        (SELECT concat_ws(',', count(*), coalesce(extract(epoch FROM max(i.decided_at))::text, ''))
           FROM public.intelligence_items i WHERE i.project_id = p_project_id AND i.review_state IN ('accepted', 'applied')),
        (SELECT coalesce(string_agg(m.id::text || ':' || coalesce(m.current_revision, ''), ',' ORDER BY m.id), '')
           FROM public.meetings m WHERE m.project_id = p_project_id)
    ));
$$;
REVOKE ALL ON FUNCTION public.project_intelligence_stamp(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_intelligence_stamp(TEXT) TO authenticated;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261118000600_intelligence_quality')
ON CONFLICT (version) DO NOTHING;
