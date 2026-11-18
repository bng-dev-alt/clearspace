-- ============================================================
-- 20261118000500 -- Intelligence core: meetings, transcripts, AI runs, intelligence items
--
-- Implements docs/intelligence/ARCHITECTURE.md §9 for Project Intelligence 2.0 + Meeting Intelligence (text MVP).
-- Purely ADDITIVE: new tables and functions only. No existing table, policy, function or row is changed or deleted.
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS). Apply after 20261117000400.
--
-- Design
--  * Authorization reuses the existing model: every row carries `project_id TEXT` and access is
--    `is_project_member(project_id)` (SELECT / write) or `is_project_owner` (delete of foreign meetings).
--  * Composite foreign keys (meeting_id, project_id) make it IMPOSSIBLE for a transcript, run or item to point at a
--    meeting of another project.
--  * AI output enters ONLY through SECURITY DEFINER RPCs that check membership explicitly, validate evidence against
--    the stored transcript and write one run + its items in ONE transaction (all or nothing). Authenticated users have
--    no INSERT privilege on runs/items.
--  * Review / apply / undo are SECURITY INVOKER (RLS keeps applying to cards, comments, activity logs) and are guarded
--    by a state-machine trigger, so even a direct UPDATE cannot skip a state or forge an applied card.
--  * Nothing here calls an AI provider or stores an API key.
-- ============================================================

-- Preflight: refuse early and precisely instead of failing half-way.
DO $$
DECLARE
    v_missing TEXT := '';
    c TEXT;
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL THEN
        v_missing := v_missing || ' migration:20261117000100_security_foundation(apply it first)';
    ELSIF NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261117000100_security_foundation') THEN
        v_missing := v_missing || ' migration:20261117000100_security_foundation(apply it first)';
    END IF;
    IF to_regprocedure('public.is_project_member(text)') IS NULL THEN v_missing := v_missing || ' fn:is_project_member'; END IF;
    IF to_regprocedure('public.is_project_owner(text)') IS NULL THEN v_missing := v_missing || ' fn:is_project_owner'; END IF;
    IF to_regclass('public.ai_requests') IS NULL THEN v_missing := v_missing || ' table:ai_requests'; END IF;
    FOREACH c IN ARRAY ARRAY[
        'projects.id', 'columns.id', 'columns.project_id', 'columns.position',
        'cards.id', 'cards.column_id', 'cards.title', 'cards.details', 'cards.due_date', 'cards.position',
        'cards.archived', 'cards.updated_at', 'cards.assignee_name', 'cards.assignee_initials', 'cards.assignee_color',
        'task_comments.id', 'task_comments.card_id', 'task_comments.author_name', 'task_comments.content',
        'card_assignees.card_id', 'card_assignees.member_id', 'card_assignees.position',
        'activity_logs.id', 'activity_logs.project_id', 'activity_logs.card_id', 'activity_logs.actor_id',
        'activity_logs.actor_name', 'activity_logs.action_type', 'activity_logs.entity_type', 'activity_logs.details',
        'workspace_members.id', 'workspace_members.full_name', 'workspace_members.initials',
        'workspace_members.avatar_color', 'profiles.id', 'profiles.email', 'profiles.display_name']
    LOOP
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = split_part(c, '.', 1)
                         AND column_name = split_part(c, '.', 2)) THEN
            v_missing := v_missing || ' col:' || c;
        END IF;
    END LOOP;
    IF v_missing <> '' THEN
        RAISE EXCEPTION 'Preflight failed -- intelligence core cannot be installed. Missing:%. Nothing was changed.', v_missing;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 0. Helpers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;

-- Strict YYYY-MM-DD parser: returns NULL for anything that is not a real calendar date (no cast errors leak out).
CREATE OR REPLACE FUNCTION public.iso_date_or_null(p TEXT)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p IS NULL OR p !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN NULL; END IF;
    RETURN p::date;
EXCEPTION WHEN others THEN
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.iso_date_or_null(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.iso_date_or_null(TEXT) TO authenticated;

-- Folding for evidence checks done by the DATABASE (mirror of FOLD_SPEC in src/lib/intelligence/fold.ts for Latin scripts:
-- strip diacritics, lowercase, every run of non-alphanumerics = one space). Other scripts keep their letters (lowercased).
CREATE OR REPLACE FUNCTION public.fold_text(p TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT btrim(regexp_replace(lower(translate(coalesce(p, ''), 'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĨĩĪīĬĭĮįİĴĵĶķĹĺĻļĽľŃńŅņŇňŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžĐđŁłØøĦħ', 'AAAAAACEEEEIIIINOOOOOUUUUYaaaaaaceeeeiiiinooooouuuuyyAaAaAaCcCcCcCcDdEeEeEeEeEeGgGgGgGgHhIiIiIiIiIJjKkLlLlLlNnNnNnOoOoOoRrRrRrSsSsSsSsTtTtUuUuUuUuUuUuWwYyYZzZzZzDdLlOoHh')), '[^[:alnum:]]+', ' ', 'g'));
$$;
GRANT EXECUTE ON FUNCTION public.fold_text(TEXT) TO authenticated;

-- Is the quote contained in the text as WHOLE WORDS, its "..." parts in order, with >= 6 letters and >= 2 words?
-- (same rule as quoteSupported in src/lib/intelligence/evidence.ts). Used to recompute `quoteFound` so that a client can
-- never claim a verified quote the transcript does not contain.
CREATE OR REPLACE FUNCTION public.quote_in_text(p_quote TEXT, p_text TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_parts TEXT[];
    v_part TEXT;
    v_hay TEXT := ' ' || public.fold_text(p_text) || ' ';
    v_joined TEXT := '';
    v_pos INTEGER := 1;
    v_idx INTEGER;
BEGIN
    IF p_quote IS NULL OR btrim(p_quote) = '' THEN RETURN FALSE; END IF;
    v_parts := regexp_split_to_array(p_quote, '…|\.\.\.');
    FOREACH v_part IN ARRAY v_parts LOOP
        v_part := public.fold_text(v_part);
        IF v_part = '' THEN CONTINUE; END IF;
        v_joined := btrim(v_joined || ' ' || v_part);
        v_idx := position(' ' || v_part || ' ' IN substr(v_hay, v_pos));
        IF v_idx = 0 THEN RETURN FALSE; END IF;
        v_pos := v_pos + v_idx - 1 + char_length(v_part) + 1; -- the trailing space stays available for the next part
    END LOOP;
    IF v_joined = '' THEN RETURN FALSE; END IF;
    RETURN char_length(regexp_replace(v_joined, '[^[:alpha:]]', '', 'g')) >= 6
       AND array_length(string_to_array(v_joined, ' '), 1) >= 2;
END;
$$;
GRANT EXECUTE ON FUNCTION public.quote_in_text(TEXT, TEXT) TO authenticated;


-- ------------------------------------------------------------
-- 1. meetings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    created_by UUID DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('text', 'audio')),
    -- Set only by the database (transcript insert -> 'transcribed', persist_meeting_run -> 'ready').
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'uploaded', 'transcribing', 'transcribed', 'analyzing', 'ready', 'failed')),
    language_hint TEXT CHECK (language_hint IN ('cs', 'en')),
    current_revision TEXT,
    -- { "S1": "Petr Novák" }: names are entered by people; the AI never names speakers.
    speaker_names JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(speaker_names) = 'object'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_meetings_project_occurred ON public.meetings (project_id, occurred_at DESC);

DROP TRIGGER IF EXISTS meetings_touch ON public.meetings;
CREATE TRIGGER meetings_touch BEFORE UPDATE ON public.meetings
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- project_id and created_by never change (a meeting cannot be moved to another project).
CREATE OR REPLACE FUNCTION public.guard_meeting_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.source_kind IS DISTINCT FROM OLD.source_kind THEN
        RAISE EXCEPTION 'Projekt, autora ani typ zdroje porady nelze měnit.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_meeting_identity() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meetings_guard_identity ON public.meetings;
CREATE TRIGGER meetings_guard_identity BEFORE UPDATE ON public.meetings
    FOR EACH ROW EXECUTE FUNCTION public.guard_meeting_identity();

ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members read meetings" ON public.meetings;
CREATE POLICY "Members read meetings" ON public.meetings FOR SELECT TO authenticated
    USING (public.is_project_member(project_id));
DROP POLICY IF EXISTS "Members create meetings" ON public.meetings;
CREATE POLICY "Members create meetings" ON public.meetings FOR INSERT TO authenticated
    WITH CHECK (public.is_project_member(project_id) AND created_by = auth.uid());
DROP POLICY IF EXISTS "Members edit meetings" ON public.meetings;
CREATE POLICY "Members edit meetings" ON public.meetings FOR UPDATE TO authenticated
    USING (public.is_project_member(project_id)) WITH CHECK (public.is_project_member(project_id));
DROP POLICY IF EXISTS "Creator or owner deletes meetings" ON public.meetings;
CREATE POLICY "Creator or owner deletes meetings" ON public.meetings FOR DELETE TO authenticated
    USING (public.is_project_member(project_id) AND (created_by = auth.uid() OR public.is_project_owner(project_id)));

REVOKE ALL ON public.meetings FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.meetings TO authenticated;
GRANT INSERT (id, project_id, title, occurred_at, created_by, source_kind, language_hint, speaker_names)
    ON public.meetings TO authenticated;
GRANT UPDATE (title, occurred_at, language_hint, speaker_names) ON public.meetings TO authenticated;
GRANT ALL ON public.meetings TO service_role;

-- ------------------------------------------------------------
-- 2. meeting_transcripts (immutable revisions; shape follows UMC umc.transcript 1.0, see ARCHITECTURE §9.6)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meeting_transcripts (
    meeting_id UUID NOT NULL,
    project_id TEXT NOT NULL,
    revision TEXT NOT NULL CHECK (revision ~ '^[0-9a-f]{64}$'),
    contract_version TEXT NOT NULL DEFAULT '1.0' CHECK (char_length(contract_version) <= 16),
    source TEXT NOT NULL CHECK (source IN ('paste', 'txt', 'md', 'vtt', 'srt', 'soniox')),
    speakers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(speakers) = 'array'),
    segments JSONB NOT NULL CHECK (jsonb_typeof(segments) = 'array' AND jsonb_array_length(segments) BETWEEN 1 AND 20000),
    coverage JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(coverage) = 'object'),
    char_count INTEGER NOT NULL CHECK (char_count BETWEEN 1 AND 400000),
    created_by UUID DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (meeting_id, revision),
    FOREIGN KEY (meeting_id, project_id) REFERENCES public.meetings (id, project_id) ON DELETE CASCADE
);

-- Segment ids must be unique non-empty strings with non-empty text; total text bounded (400k characters, UMC eligibility).
CREATE OR REPLACE FUNCTION public.validate_meeting_transcript()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bad INTEGER;
    v_distinct INTEGER;
    v_total BIGINT;
BEGIN
    SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(NEW.segments) s
    WHERE jsonb_typeof(s) <> 'object'
       OR jsonb_typeof(s -> 'id') IS DISTINCT FROM 'string'
       OR char_length(s ->> 'id') NOT BETWEEN 1 AND 200
       OR (s ->> 'id') ~ '[\s\]\[#]'
       OR jsonb_typeof(s -> 'text') IS DISTINCT FROM 'string'
       OR char_length(btrim(s ->> 'text')) = 0;
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'Přepis obsahuje neplatné segmenty.' USING ERRCODE = '22023';
    END IF;
    SELECT count(DISTINCT s ->> 'id'), coalesce(sum(char_length(s ->> 'text')), 0)
      INTO v_distinct, v_total FROM jsonb_array_elements(NEW.segments) s;
    IF v_distinct <> jsonb_array_length(NEW.segments) THEN
        RAISE EXCEPTION 'Id segmentů přepisu musí být jedinečná.' USING ERRCODE = '22023';
    END IF;
    IF v_total > 400000 THEN
        RAISE EXCEPTION 'Přepis je příliš dlouhý (max 400 000 znaků).' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_meeting_transcript() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meeting_transcripts_validate ON public.meeting_transcripts;
CREATE TRIGGER meeting_transcripts_validate BEFORE INSERT ON public.meeting_transcripts
    FOR EACH ROW EXECUTE FUNCTION public.validate_meeting_transcript();

-- A new transcript revision becomes the meeting's current one and moves it to 'transcribed' (the client never writes status).
CREATE OR REPLACE FUNCTION public.on_meeting_transcript_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.meetings
       SET current_revision = NEW.revision,
           status = CASE WHEN status IN ('draft', 'uploaded', 'transcribing', 'failed', 'ready', 'analyzing') THEN 'transcribed' ELSE status END
     WHERE id = NEW.meeting_id AND project_id = NEW.project_id;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.on_meeting_transcript_insert() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meeting_transcripts_after_insert ON public.meeting_transcripts;
CREATE TRIGGER meeting_transcripts_after_insert AFTER INSERT ON public.meeting_transcripts
    FOR EACH ROW EXECUTE FUNCTION public.on_meeting_transcript_insert();

ALTER TABLE public.meeting_transcripts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members read transcripts" ON public.meeting_transcripts;
CREATE POLICY "Members read transcripts" ON public.meeting_transcripts FOR SELECT TO authenticated
    USING (public.is_project_member(project_id));
DROP POLICY IF EXISTS "Members add transcripts" ON public.meeting_transcripts;
CREATE POLICY "Members add transcripts" ON public.meeting_transcripts FOR INSERT TO authenticated
    WITH CHECK (public.is_project_member(project_id) AND created_by = auth.uid());

REVOKE ALL ON public.meeting_transcripts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.meeting_transcripts TO authenticated;
GRANT INSERT (meeting_id, project_id, revision, contract_version, source, speakers, segments, coverage, char_count, created_by)
    ON public.meeting_transcripts TO authenticated;
GRANT ALL ON public.meeting_transcripts TO service_role;
-- Re-running this file AFTER migration 0600 must not drop the lineage column grants that file adds.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'meeting_transcripts' AND column_name = 'parent_revision') THEN
        GRANT INSERT (parent_revision, edit_note) ON public.meeting_transcripts TO authenticated;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 3. intelligence_runs (one AI run = one validated output; project briefs and meeting briefs)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intelligence_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    meeting_id UUID,
    kind TEXT NOT NULL CHECK (kind IN ('meeting_brief', 'project_brief')),
    status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
    transcript_revision TEXT,
    input_fingerprint TEXT NOT NULL CHECK (char_length(input_fingerprint) BETWEEN 1 AND 128),
    contract_version TEXT NOT NULL CHECK (char_length(contract_version) BETWEEN 1 AND 40),
    prompt_version TEXT NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 64),
    validator_version TEXT NOT NULL CHECK (char_length(validator_version) BETWEEN 1 AND 64),
    model TEXT CHECK (char_length(model) <= 100),
    ai_request_id UUID REFERENCES public.ai_requests(id) ON DELETE SET NULL,
    output JSONB CHECK (output IS NULL OR jsonb_typeof(output) = 'object'),
    rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
    error_code TEXT CHECK (char_length(error_code) <= 64),
    superseded_at TIMESTAMP WITH TIME ZONE,
    created_by UUID DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    FOREIGN KEY (meeting_id, project_id) REFERENCES public.meetings (id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id, transcript_revision) REFERENCES public.meeting_transcripts (meeting_id, revision) ON DELETE CASCADE,
    CHECK ((kind = 'meeting_brief') = (meeting_id IS NOT NULL)),
    CHECK (kind <> 'meeting_brief' OR transcript_revision IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_runs_project_kind_created ON public.intelligence_runs (project_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_meeting_created ON public.intelligence_runs (meeting_id, created_at DESC);
-- Idempotency: at most one active succeeded run per (meeting, transcript revision, prompt version).
CREATE UNIQUE INDEX IF NOT EXISTS uq_runs_meeting_revision_prompt
    ON public.intelligence_runs (meeting_id, transcript_revision, prompt_version)
    WHERE kind = 'meeting_brief' AND status = 'succeeded' AND superseded_at IS NULL;

ALTER TABLE public.intelligence_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members read runs" ON public.intelligence_runs;
CREATE POLICY "Members read runs" ON public.intelligence_runs FOR SELECT TO authenticated
    USING (public.is_project_member(project_id));
REVOKE ALL ON public.intelligence_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.intelligence_runs TO authenticated;
GRANT ALL ON public.intelligence_runs TO service_role;

-- ------------------------------------------------------------
-- 4. intelligence_items (decisions, action items, risks... with evidence and a review state)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intelligence_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    run_id UUID NOT NULL,
    meeting_id UUID,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'action_item', 'follow_up', 'risk', 'blocker', 'open_question')),
    text TEXT NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 800),
    support TEXT NOT NULL CHECK (support IN ('linked', 'unverified')),
    -- Evidence[]: [{ref:'segment:<id>', quote, quoteFound, startMs, endMs}], 1..4 entries; validated by trigger.
    evidence JSONB NOT NULL,
    owner_text TEXT CHECK (char_length(owner_text) <= 100),
    due_text TEXT CHECK (char_length(due_text) <= 100),
    suggested_card_id TEXT,
    review_state TEXT NOT NULL DEFAULT 'proposed'
        CHECK (review_state IN ('proposed', 'accepted', 'rejected', 'applied', 'superseded')),
    -- Set ONLY by a human (review/apply RPCs); the AI never decides an assignee or a date.
    assignee_member_id TEXT REFERENCES public.workspace_members(id) ON DELETE SET NULL,
    due_date DATE,
    applied_card_id TEXT REFERENCES public.cards(id) ON DELETE SET NULL,
    applied_mode TEXT CHECK (applied_mode IN ('create_card', 'link_card', 'comment')),
    applied_at TIMESTAMP WITH TIME ZONE,
    decided_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    decided_at TIMESTAMP WITH TIME ZONE,
    dedupe_key TEXT NOT NULL CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
    duplicate_of UUID REFERENCES public.intelligence_items(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (run_id, ordinal),
    FOREIGN KEY (run_id, project_id) REFERENCES public.intelligence_runs (id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id, project_id) REFERENCES public.meetings (id, project_id) ON DELETE CASCADE,
    CHECK ((review_state = 'applied') = (applied_mode IS NOT NULL)),
    CHECK (review_state <> 'applied' OR applied_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_items_project_state_kind ON public.intelligence_items (project_id, review_state, kind);
CREATE INDEX IF NOT EXISTS idx_items_project_dedupe ON public.intelligence_items (project_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_items_meeting ON public.intelligence_items (meeting_id, ordinal);

DROP TRIGGER IF EXISTS items_touch ON public.intelligence_items;
CREATE TRIGGER items_touch BEFORE UPDATE ON public.intelligence_items
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- INSERT guard: evidence must be a well-formed list of 1..4 references to REAL segments of the run's transcript revision,
-- and `linked` support needs at least one quote that the validator found. Defence in depth behind the persist RPC.
CREATE OR REPLACE FUNCTION public.validate_intelligence_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rev TEXT;
    v_segments JSONB;
    e JSONB;
    v_seg JSONB;
    v_ord INTEGER;
    v_next TEXT;
    v_quote TEXT;
    v_found BOOLEAN;
    v_out JSONB := '[]'::jsonb;
    v_any_linked BOOLEAN := FALSE;
BEGIN
    IF jsonb_typeof(NEW.evidence) <> 'array' OR jsonb_array_length(NEW.evidence) NOT BETWEEN 1 AND 4 THEN
        RAISE EXCEPTION 'Evidence musí obsahovat 1 až 4 odkazy.' USING ERRCODE = '22023';
    END IF;
    IF NEW.meeting_id IS NULL THEN
        RAISE EXCEPTION 'Položka porady musí odkazovat na poradu.' USING ERRCODE = '22023';
    END IF;
    SELECT r.transcript_revision INTO v_rev FROM public.intelligence_runs r WHERE r.id = NEW.run_id;
    SELECT t.segments INTO v_segments FROM public.meeting_transcripts t
     WHERE t.meeting_id = NEW.meeting_id AND t.revision = v_rev;
    IF v_segments IS NULL THEN
        RAISE EXCEPTION 'Přepis, na který se položka odvolává, neexistuje.' USING ERRCODE = '22023';
    END IF;
    -- The DATABASE is authoritative for evidence: `quoteFound` is recomputed from the stored transcript (a client can only
    -- DOWNGRADE: quoteFound stays true only if the caller said so AND the quote really is in the segment or in it plus the
    -- next one), times are taken from the segment, and `support` can never be higher than what the evidence proves.
    FOR e IN SELECT * FROM jsonb_array_elements(NEW.evidence) LOOP
        IF jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'ref') IS DISTINCT FROM 'string'
           OR (e ->> 'ref') !~ '^segment:[^\s\]\[#]{1,200}$' THEN
            RAISE EXCEPTION 'Neplatný odkaz na důkaz.' USING ERRCODE = '22023';
        END IF;
        v_seg := NULL;
        SELECT s.val, s.ord INTO v_seg, v_ord
          FROM jsonb_array_elements(v_segments) WITH ORDINALITY AS s(val, ord) WHERE s.val ->> 'id' = substr(e ->> 'ref', 9);
        IF v_seg IS NULL THEN
            RAISE EXCEPTION 'Důkaz odkazuje na neexistující segment přepisu (%).', e ->> 'ref' USING ERRCODE = '22023';
        END IF;
        v_quote := CASE WHEN jsonb_typeof(e -> 'quote') = 'string' THEN e ->> 'quote' ELSE NULL END;
        IF v_quote IS NOT NULL AND char_length(v_quote) > 200 THEN
            RAISE EXCEPTION 'Citace je příliš dlouhá (max 200 znaků).' USING ERRCODE = '22023';
        END IF;
        v_next := (v_segments -> v_ord::integer) ->> 'text'; -- 0-based index v_ord = the following segment (NULL at the end)
        v_found := (e -> 'quoteFound' = 'true'::jsonb)
                   AND v_quote IS NOT NULL
                   AND (public.quote_in_text(v_quote, v_seg ->> 'text')
                        OR (v_next IS NOT NULL AND public.quote_in_text(v_quote, (v_seg ->> 'text') || ' ' || v_next)));
        v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
            'ref', e ->> 'ref', 'quote', v_quote, 'quoteFound', v_found,
            'startMs', v_seg -> 'startMs', 'endMs', v_seg -> 'endMs',
            'flag', CASE WHEN e ->> 'flag' = 'negation_nearby' THEN 'negation_nearby' ELSE NULL END)));
        IF v_found AND coalesce(e ->> 'flag', '') = '' THEN v_any_linked := TRUE; END IF;
    END LOOP;
    NEW.evidence := v_out;
    IF NEW.support = 'linked' AND NOT v_any_linked THEN
        NEW.support := 'unverified';
    END IF;
    IF NEW.kind IN ('decision', 'action_item') AND NEW.support <> 'linked' THEN
        -- 23514 (not 22023): persist_meeting_run skips such an item and counts it; every OTHER violation still aborts the whole run
        RAISE EXCEPTION 'Rozhodnutí a úkoly musí být podložené nalezenou citací.' USING ERRCODE = '23514';
    END IF;
    IF NEW.review_state <> 'proposed' THEN
        RAISE EXCEPTION 'Nová položka musí začít ve stavu "proposed".' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_intelligence_item() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS items_validate_insert ON public.intelligence_items;
CREATE TRIGGER items_validate_insert BEFORE INSERT ON public.intelligence_items
    FOR EACH ROW EXECUTE FUNCTION public.validate_intelligence_item();

-- UPDATE guard: the review state machine + immutability of everything the AI produced.
--   proposed -> accepted | rejected | superseded
--   accepted -> applied | rejected | superseded
--   rejected -> proposed (reopen) | superseded
--   applied  -> accepted (undo)
--   superseded: terminal
CREATE OR REPLACE FUNCTION public.guard_intelligence_item_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.meeting_id IS DISTINCT FROM OLD.meeting_id
       OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.support IS DISTINCT FROM OLD.support OR NEW.evidence IS DISTINCT FROM OLD.evidence
       OR NEW.owner_text IS DISTINCT FROM OLD.owner_text OR NEW.due_text IS DISTINCT FROM OLD.due_text
       OR NEW.suggested_card_id IS DISTINCT FROM OLD.suggested_card_id OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
       -- duplicate_of may only be CLEARED (ON DELETE SET NULL when the referenced item disappears)
       OR (NEW.duplicate_of IS DISTINCT FROM OLD.duplicate_of AND NEW.duplicate_of IS NOT NULL)
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Výstup AI (typ, důkazy, podpora) nelze měnit.' USING ERRCODE = '42501';
    END IF;

    -- Only an APPLIED item may point at a card (an accepted/open one cannot carry a forged applied card).
    IF NEW.review_state <> 'applied' AND (NEW.applied_card_id IS NOT NULL OR NEW.applied_mode IS NOT NULL OR NEW.applied_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Nepoužitá položka nesmí odkazovat na kartu.' USING ERRCODE = '55000';
    END IF;
    -- Who decided and when is set by the DATABASE on a state change; it cannot be written directly.
    IF NEW.review_state IS DISTINCT FROM OLD.review_state THEN
        IF auth.uid() IS NOT NULL THEN
            NEW.decided_by := auth.uid();
            NEW.decided_at := now();
        END IF;
    ELSIF (NEW.decided_by IS DISTINCT FROM OLD.decided_by AND NEW.decided_by IS NOT NULL)
          OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
        RAISE EXCEPTION 'Čas a autora rozhodnutí nelze měnit přímo.' USING ERRCODE = '42501';
    END IF;

    IF NEW.review_state = OLD.review_state THEN
        -- Edits of the human-controlled fields are only possible while the item is still open.
        -- (assignee / applied card may still be CLEARED: ON DELETE SET NULL of the member or card they point at)
        IF OLD.review_state NOT IN ('proposed', 'accepted')
           AND (NEW.text IS DISTINCT FROM OLD.text
                OR (NEW.assignee_member_id IS DISTINCT FROM OLD.assignee_member_id AND NEW.assignee_member_id IS NOT NULL)
                OR NEW.due_date IS DISTINCT FROM OLD.due_date
                OR (NEW.applied_card_id IS DISTINCT FROM OLD.applied_card_id AND NEW.applied_card_id IS NOT NULL)
                OR NEW.applied_mode IS DISTINCT FROM OLD.applied_mode OR NEW.applied_at IS DISTINCT FROM OLD.applied_at) THEN
            RAISE EXCEPTION 'Položku ve stavu "%" už nelze upravovat.', OLD.review_state USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;

    IF NOT ((OLD.review_state = 'proposed' AND NEW.review_state IN ('accepted', 'rejected', 'superseded'))
         OR (OLD.review_state = 'accepted' AND NEW.review_state IN ('applied', 'rejected', 'superseded'))
         OR (OLD.review_state = 'rejected' AND NEW.review_state IN ('proposed', 'superseded'))
         OR (OLD.review_state = 'applied' AND NEW.review_state = 'accepted')) THEN
        RAISE EXCEPTION 'Neplatný přechod stavu položky: % -> %.', OLD.review_state, NEW.review_state USING ERRCODE = '55000';
    END IF;

    IF NEW.review_state = 'applied' THEN
        IF NEW.applied_card_id IS NULL OR NEW.applied_mode IS NULL OR NEW.applied_at IS NULL THEN
            RAISE EXCEPTION 'Použitá položka musí odkazovat na kartu.' USING ERRCODE = '55000';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.cards c JOIN public.columns col ON col.id = c.column_id
                        WHERE c.id = NEW.applied_card_id AND col.project_id = OLD.project_id) THEN
            RAISE EXCEPTION 'Karta nepatří do projektu položky.' USING ERRCODE = '42501';
        END IF;
    ELSE
        IF NEW.applied_card_id IS NOT NULL OR NEW.applied_mode IS NOT NULL OR NEW.applied_at IS NOT NULL THEN
            RAISE EXCEPTION 'Nepoužitá položka nesmí odkazovat na kartu.' USING ERRCODE = '55000';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_intelligence_item_update() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS items_guard_update ON public.intelligence_items;
CREATE TRIGGER items_guard_update BEFORE UPDATE ON public.intelligence_items
    FOR EACH ROW EXECUTE FUNCTION public.guard_intelligence_item_update();

ALTER TABLE public.intelligence_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members read items" ON public.intelligence_items;
CREATE POLICY "Members read items" ON public.intelligence_items FOR SELECT TO authenticated
    USING (public.is_project_member(project_id));
DROP POLICY IF EXISTS "Members review items" ON public.intelligence_items;
CREATE POLICY "Members review items" ON public.intelligence_items FOR UPDATE TO authenticated
    USING (public.is_project_member(project_id)) WITH CHECK (public.is_project_member(project_id));
REVOKE ALL ON public.intelligence_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.intelligence_items TO authenticated;
GRANT UPDATE (review_state, text, assignee_member_id, due_date, applied_card_id, applied_mode, applied_at, decided_by, decided_at)
    ON public.intelligence_items TO authenticated;
GRANT ALL ON public.intelligence_items TO service_role;

-- ------------------------------------------------------------
-- 5. persist_meeting_run -- the ONLY way AI output enters the tables (atomic, idempotent, membership-checked)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.persist_meeting_run(
    p_meeting_id UUID,
    p_run JSONB,
    p_items JSONB,
    p_force BOOLEAN DEFAULT FALSE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_m public.meetings%ROWTYPE;
    v_status TEXT;
    v_rev TEXT;
    v_prompt TEXT;
    v_run_id UUID;
    v_old UUID;
    v_it JSONB;
    v_ord INTEGER;
    v_dedupe TEXT;
    v_dup UUID;
    v_suggested TEXT;
    v_skipped INTEGER := 0;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    IF p_run IS NULL OR jsonb_typeof(p_run) <> 'object' OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
        RAISE EXCEPTION 'Neplatný výstup AI.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_items) > 300 THEN
        RAISE EXCEPTION 'Příliš mnoho položek.' USING ERRCODE = '22023';
    END IF;

    -- Authorization first (this function bypasses RLS, so the check is explicit). The row lock serializes
    -- concurrent persists for the same meeting.
    SELECT * INTO v_m FROM public.meetings WHERE id = p_meeting_id FOR UPDATE;
    IF NOT FOUND OR NOT public.is_project_member(v_m.project_id) THEN
        RAISE EXCEPTION 'Porada neexistuje nebo k ní nemáte přístup.' USING ERRCODE = '42501';
    END IF;

    v_status := coalesce(p_run ->> 'status', 'succeeded');
    v_rev := p_run ->> 'transcript_revision';
    v_prompt := p_run ->> 'prompt_version';
    IF v_status NOT IN ('succeeded', 'failed') OR v_rev IS NULL OR v_prompt IS NULL THEN
        RAISE EXCEPTION 'Neplatná metadata běhu AI.' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.meeting_transcripts WHERE meeting_id = p_meeting_id AND revision = v_rev) THEN
        RAISE EXCEPTION 'Přepis (revize) neexistuje.' USING ERRCODE = '22023';
    END IF;
    IF v_status = 'failed' AND jsonb_array_length(p_items) > 0 THEN
        RAISE EXCEPTION 'Neúspěšný běh nesmí mít položky.' USING ERRCODE = '22023';
    END IF;
    -- the provenance link must be the caller's own ledger row of this feature (a client cannot attach someone else's request)
    IF nullif(p_run ->> 'ai_request_id', '') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.ai_requests r WHERE r.id = (p_run ->> 'ai_request_id')::uuid AND r.user_id = v_uid) THEN
        RAISE EXCEPTION 'Neplatný záznam o AI požadavku.' USING ERRCODE = '42501';
    END IF;

    IF v_status = 'succeeded' THEN
        -- Idempotency: the same transcript revision + prompt version is analysed once, unless re-run is forced.
        IF EXISTS (SELECT 1 FROM public.intelligence_runs r
                    WHERE r.meeting_id = p_meeting_id AND r.transcript_revision = v_rev AND r.prompt_version = v_prompt
                      AND r.kind = 'meeting_brief' AND r.status = 'succeeded' AND r.superseded_at IS NULL)
           AND NOT coalesce(p_force, FALSE) THEN
            RAISE EXCEPTION 'Tato verze přepisu už byla analyzována.' USING ERRCODE = '23505';
        END IF;
        -- Older active runs (any revision) are superseded. Only OPEN suggestions (proposed / rejected) are replaced by the
        -- new analysis; items a human ACCEPTED or APPLIED are approved project knowledge and are never touched here.
        -- A human withdraws an accepted item explicitly (review 'reject'); the duplicate hint on new items points at them.
        FOR v_old IN SELECT r.id FROM public.intelligence_runs r
                      WHERE r.meeting_id = p_meeting_id AND r.kind = 'meeting_brief' AND r.status = 'succeeded'
                        AND r.superseded_at IS NULL LOOP
            UPDATE public.intelligence_runs SET superseded_at = now() WHERE id = v_old;
            UPDATE public.intelligence_items SET review_state = 'superseded'
             WHERE run_id = v_old AND review_state IN ('proposed', 'rejected');
        END LOOP;
    END IF;

    INSERT INTO public.intelligence_runs
        (project_id, meeting_id, kind, status, transcript_revision, input_fingerprint, contract_version,
         prompt_version, validator_version, model, ai_request_id, output, rejected_count, error_code, created_by)
    VALUES
        (v_m.project_id, p_meeting_id, 'meeting_brief', v_status, v_rev,
         coalesce(p_run ->> 'input_fingerprint', ''), coalesce(p_run ->> 'contract_version', ''),
         v_prompt, coalesce(p_run ->> 'validator_version', ''), p_run ->> 'model',
         nullif(p_run ->> 'ai_request_id', '')::uuid, p_run -> 'output',
         coalesce((p_run ->> 'rejected_count')::integer, 0), p_run ->> 'error_code', v_uid)
    RETURNING id INTO v_run_id;

    v_ord := 0;
    FOR v_it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        v_dedupe := v_it ->> 'dedupe_key';
        v_suggested := nullif(v_it ->> 'suggested_card_id', '');
        IF v_suggested IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.cards c JOIN public.columns col ON col.id = c.column_id
             WHERE c.id = v_suggested AND col.project_id = v_m.project_id AND NOT c.archived) THEN
            RAISE EXCEPTION 'Navržená karta nepatří do tohoto projektu.' USING ERRCODE = '22023';
        END IF;
        -- Possible duplicate: an equivalent open/accepted/applied item of ANOTHER run in the same project.
        SELECT i.id INTO v_dup FROM public.intelligence_items i
         WHERE i.project_id = v_m.project_id AND i.dedupe_key = v_dedupe AND i.run_id <> v_run_id
           AND i.review_state IN ('proposed', 'accepted', 'applied')
         ORDER BY (i.review_state = 'applied') DESC, (i.review_state = 'accepted') DESC, i.created_at LIMIT 1;

        -- The item trigger recomputes the evidence from the stored transcript. An item the DATABASE cannot support (a decision or
        -- task whose quote is not really in the transcript) is skipped and counted, it does not fail the whole run.
        BEGIN
            INSERT INTO public.intelligence_items
                (project_id, run_id, meeting_id, ordinal, kind, text, support, evidence, owner_text, due_text,
                 suggested_card_id, dedupe_key, duplicate_of)
            VALUES
                (v_m.project_id, v_run_id, p_meeting_id, v_ord, v_it ->> 'kind', v_it ->> 'text', v_it ->> 'support',
                 v_it -> 'evidence', nullif(v_it ->> 'owner_text', ''), nullif(v_it ->> 'due_text', ''),
                 v_suggested, v_dedupe, v_dup);
            v_ord := v_ord + 1;
        EXCEPTION WHEN SQLSTATE '23514' THEN
            v_skipped := v_skipped + 1;
        END;
    END LOOP;
    IF v_skipped > 0 THEN
        UPDATE public.intelligence_runs SET rejected_count = rejected_count + v_skipped WHERE id = v_run_id;
    END IF;

    IF v_status = 'succeeded' THEN
        -- status only: the current revision is owned by the transcript trigger (analysing an OLDER revision must not rewind it)
        UPDATE public.meetings SET status = CASE WHEN current_revision = v_rev THEN 'ready' ELSE status END WHERE id = p_meeting_id;
    END IF;
    RETURN v_run_id;
END;
$$;

-- persist_project_brief: stores the validated Project Brief and marks the previous one superseded.
CREATE OR REPLACE FUNCTION public.persist_project_brief(p_project_id TEXT, p_run JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_status TEXT;
    v_id UUID;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    IF p_project_id IS NULL OR NOT public.is_project_member(p_project_id) THEN
        RAISE EXCEPTION 'K tomuto projektu nemáte přístup.' USING ERRCODE = '42501';
    END IF;
    IF p_run IS NULL OR jsonb_typeof(p_run) <> 'object' THEN
        RAISE EXCEPTION 'Neplatný výstup AI.' USING ERRCODE = '22023';
    END IF;
    v_status := coalesce(p_run ->> 'status', 'succeeded');
    IF v_status NOT IN ('succeeded', 'failed') THEN
        RAISE EXCEPTION 'Neplatný stav běhu AI.' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('project_brief:' || p_project_id, 0));
    IF v_status = 'succeeded' THEN
        UPDATE public.intelligence_runs SET superseded_at = now()
         WHERE project_id = p_project_id AND kind = 'project_brief' AND status = 'succeeded' AND superseded_at IS NULL;
    END IF;
    INSERT INTO public.intelligence_runs
        (project_id, kind, status, input_fingerprint, contract_version, prompt_version, validator_version,
         model, ai_request_id, output, rejected_count, error_code, created_by)
    VALUES
        (p_project_id, 'project_brief', v_status, coalesce(p_run ->> 'input_fingerprint', ''),
         coalesce(p_run ->> 'contract_version', ''), coalesce(p_run ->> 'prompt_version', ''),
         coalesce(p_run ->> 'validator_version', ''), p_run ->> 'model', nullif(p_run ->> 'ai_request_id', '')::uuid,
         p_run -> 'output', coalesce((p_run ->> 'rejected_count')::integer, 0), p_run ->> 'error_code', v_uid)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- ------------------------------------------------------------
-- 6. Review / apply / undo (SECURITY INVOKER: RLS keeps applying to cards, comments and activity logs)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_intelligence_item(p_item UUID, p_decision TEXT, p_edits JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_it public.intelligence_items%ROWTYPE;
    v_new TEXT;
    v_text TEXT;
    v_member TEXT;
    v_due DATE;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    IF p_decision NOT IN ('accept', 'reject', 'reopen') THEN
        RAISE EXCEPTION 'Neplatné rozhodnutí.' USING ERRCODE = '22023';
    END IF;
    p_edits := coalesce(p_edits, '{}'::jsonb);
    IF jsonb_typeof(p_edits) <> 'object' THEN
        RAISE EXCEPTION 'Neplatné úpravy.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_it FROM public.intelligence_items WHERE id = p_item FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Položka neexistuje nebo k ní nemáte přístup.' USING ERRCODE = '42501';
    END IF;

    v_new := CASE p_decision WHEN 'accept' THEN 'accepted' WHEN 'reject' THEN 'rejected' ELSE 'proposed' END;
    -- Idempotent repeat of the same decision.
    IF v_it.review_state = v_new THEN
        RETURN jsonb_build_object('item_id', v_it.id, 'review_state', v_it.review_state, 'unchanged', TRUE);
    END IF;

    v_text := coalesce(nullif(btrim(p_edits ->> 'text'), ''), v_it.text);
    v_member := coalesce(nullif(p_edits ->> 'assignee_member_id', ''), v_it.assignee_member_id);
    IF nullif(p_edits ->> 'due_date', '') IS NOT NULL AND public.iso_date_or_null(p_edits ->> 'due_date') IS NULL THEN
        RAISE EXCEPTION 'Neplatné datum.' USING ERRCODE = '22023';
    END IF;
    v_due := coalesce(public.iso_date_or_null(p_edits ->> 'due_date'), v_it.due_date);

    UPDATE public.intelligence_items
       SET review_state = v_new, text = v_text, assignee_member_id = v_member, due_date = v_due,
           decided_by = auth.uid(), decided_at = now()
     WHERE id = p_item;
    RETURN jsonb_build_object('item_id', p_item, 'review_state', v_new, 'unchanged', FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_intelligence_item(p_item UUID, p_target JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_it public.intelligence_items%ROWTYPE;
    v_mode TEXT;
    v_card_id TEXT;
    v_col TEXT;
    v_title TEXT;
    v_details TEXT;
    v_due TEXT;
    v_member TEXT;
    v_mname TEXT; v_minit TEXT; v_mcolor TEXT;
    v_pos INTEGER;
    v_actor TEXT;
    v_quote TEXT;
    v_comment TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    IF p_target IS NULL OR jsonb_typeof(p_target) <> 'object' THEN
        RAISE EXCEPTION 'Neplatný cíl.' USING ERRCODE = '22023';
    END IF;
    v_mode := p_target ->> 'mode';
    IF v_mode IS NULL OR v_mode NOT IN ('create_card', 'link_card', 'comment') THEN
        RAISE EXCEPTION 'Neplatný režim použití.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_it FROM public.intelligence_items WHERE id = p_item FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Položka neexistuje nebo k ní nemáte přístup.' USING ERRCODE = '42501';
    END IF;

    -- Idempotency: a second apply returns the first result and writes nothing.
    IF v_it.review_state = 'applied' THEN
        RETURN jsonb_build_object('item_id', v_it.id, 'card_id', v_it.applied_card_id, 'mode', v_it.applied_mode,
                                  'already_applied', TRUE);
    END IF;
    IF v_it.review_state NOT IN ('proposed', 'accepted') THEN
        RAISE EXCEPTION 'Položku ve stavu "%" nelze použít.', v_it.review_state USING ERRCODE = '55000';
    END IF;

    SELECT coalesce(nullif(btrim(display_name), ''), email) INTO v_actor FROM public.profiles WHERE id = auth.uid();
    v_actor := coalesce(v_actor, 'uživatel');
    SELECT e ->> 'quote' INTO v_quote FROM jsonb_array_elements(v_it.evidence) e
     WHERE e -> 'quoteFound' = 'true'::jsonb LIMIT 1;

    IF v_mode = 'create_card' THEN
        IF v_it.kind NOT IN ('action_item', 'follow_up') THEN
            RAISE EXCEPTION 'Kartu lze vytvořit jen z úkolu nebo navazující akce.' USING ERRCODE = '22023';
        END IF;
        -- Duplicate prevention: an equivalent item was already turned into a card. Needs an explicit override.
        IF v_it.duplicate_of IS NOT NULL AND NOT coalesce((p_target ->> 'allow_duplicate')::boolean, FALSE)
           AND EXISTS (SELECT 1 FROM public.intelligence_items d WHERE d.id = v_it.duplicate_of AND d.review_state = 'applied') THEN
            RAISE EXCEPTION 'Stejný úkol už byl vytvořen z jiné porady.' USING ERRCODE = '23505';
        END IF;
        v_col := p_target ->> 'column_id';
        IF v_col IS NULL OR NOT EXISTS (SELECT 1 FROM public.columns WHERE id = v_col AND project_id = v_it.project_id) THEN
            RAISE EXCEPTION 'Sloupec nepatří do projektu položky.' USING ERRCODE = '42501';
        END IF;
        v_title := coalesce(nullif(btrim(p_target ->> 'title'), ''), left(v_it.text, 300));
        IF char_length(v_title) > 300 THEN
            RAISE EXCEPTION 'Název karty je příliš dlouhý.' USING ERRCODE = '22023';
        END IF;
        v_details := coalesce(p_target ->> 'details', '');
        IF char_length(v_details) > 8000 THEN
            RAISE EXCEPTION 'Popis karty je příliš dlouhý.' USING ERRCODE = '22023';
        END IF;
        v_due := coalesce(nullif(p_target ->> 'due_date', ''), v_it.due_date::text);
        IF v_due IS NOT NULL AND public.iso_date_or_null(v_due) IS NULL THEN
            RAISE EXCEPTION 'Neplatné datum.' USING ERRCODE = '22023';
        END IF;
        v_member := coalesce(nullif(p_target ->> 'assignee_member_id', ''), v_it.assignee_member_id);
        IF v_member IS NOT NULL THEN
            SELECT full_name, initials, avatar_color INTO v_mname, v_minit, v_mcolor
              FROM public.workspace_members WHERE id = v_member;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Neznámý řešitel.' USING ERRCODE = '22023';
            END IF;
        END IF;

        SELECT coalesce(max(position), -1) + 1 INTO v_pos FROM public.cards WHERE column_id = v_col;
        v_card_id := 'card-' || replace(gen_random_uuid()::text, '-', '');
        INSERT INTO public.cards (id, column_id, title, details, due_date, position, assignee_name, assignee_initials, assignee_color)
        VALUES (v_card_id, v_col, v_title, v_details, v_due, v_pos, v_mname, v_minit, v_mcolor);
        IF v_member IS NOT NULL THEN
            INSERT INTO public.card_assignees (card_id, member_id, position) VALUES (v_card_id, v_member, 0);
        END IF;
        INSERT INTO public.activity_logs (id, project_id, card_id, actor_id, actor_name, action_type, entity_type, details)
        VALUES ('act-' || replace(gen_random_uuid()::text, '-', ''), v_it.project_id, v_card_id, auth.uid(), v_actor,
                'card_created', 'task',
                jsonb_build_object('title', v_title, 'source',
                    jsonb_build_object('type', 'intelligence_item', 'itemId', v_it.id, 'meetingId', v_it.meeting_id)));
    ELSE
        v_card_id := p_target ->> 'card_id';
        IF v_card_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM public.cards c JOIN public.columns col ON col.id = c.column_id
             WHERE c.id = v_card_id AND col.project_id = v_it.project_id) THEN
            RAISE EXCEPTION 'Karta nepatří do projektu položky.' USING ERRCODE = '42501';
        END IF;
        IF v_mode = 'comment' OR coalesce((p_target ->> 'add_comment')::boolean, FALSE) THEN
            v_comment := left('Z porady: ' || v_it.text || coalesce(' («' || v_quote || '»)', ''), 4000);
            INSERT INTO public.task_comments (id, card_id, author_name, content)
            VALUES ('cm-' || replace(gen_random_uuid()::text, '-', ''), v_card_id, v_actor, v_comment);
        END IF;
    END IF;

    -- Applying straight from "proposed" is an implicit acceptance by the same human, recorded as such.
    IF v_it.review_state = 'proposed' THEN
        UPDATE public.intelligence_items SET review_state = 'accepted', decided_by = auth.uid(), decided_at = now()
         WHERE id = p_item;
    END IF;
    UPDATE public.intelligence_items
       SET review_state = 'applied', applied_card_id = v_card_id, applied_mode = v_mode, applied_at = now(),
           assignee_member_id = coalesce(v_member, assignee_member_id),
           due_date = coalesce(CASE WHEN v_due IS NULL THEN NULL ELSE v_due::date END, due_date),
           decided_by = coalesce(decided_by, auth.uid()), decided_at = coalesce(decided_at, now())
     WHERE id = p_item;
    RETURN jsonb_build_object('item_id', p_item, 'card_id', v_card_id, 'mode', v_mode, 'already_applied', FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.undo_intelligence_item(p_item UUID, p_force BOOLEAN DEFAULT FALSE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_it public.intelligence_items%ROWTYPE;
    v_card_updated TIMESTAMP WITH TIME ZONE;
    v_actor TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    SELECT * INTO v_it FROM public.intelligence_items WHERE id = p_item FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Položka neexistuje nebo k ní nemáte přístup.' USING ERRCODE = '42501';
    END IF;
    IF v_it.review_state <> 'applied' THEN
        RETURN jsonb_build_object('item_id', v_it.id, 'review_state', v_it.review_state, 'unchanged', TRUE);
    END IF;

    IF v_it.applied_mode = 'create_card' AND v_it.applied_card_id IS NOT NULL THEN
        SELECT updated_at INTO v_card_updated FROM public.cards WHERE id = v_it.applied_card_id;
        IF FOUND THEN
            IF v_card_updated > v_it.applied_at AND NOT coalesce(p_force, FALSE) THEN
                RAISE EXCEPTION 'Karta byla od vytvoření změněna; vrácení vyžaduje potvrzení.' USING ERRCODE = '55000';
            END IF;
            -- Non-destructive: the card is archived, never deleted.
            UPDATE public.cards SET archived = TRUE, updated_at = now() WHERE id = v_it.applied_card_id;
            SELECT coalesce(nullif(btrim(display_name), ''), email) INTO v_actor FROM public.profiles WHERE id = auth.uid();
            INSERT INTO public.activity_logs (id, project_id, card_id, actor_id, actor_name, action_type, entity_type, details)
            VALUES ('act-' || replace(gen_random_uuid()::text, '-', ''), v_it.project_id, v_it.applied_card_id, auth.uid(),
                    coalesce(v_actor, 'uživatel'), 'card_archived', 'task',
                    jsonb_build_object('source', jsonb_build_object('type', 'intelligence_item_undo', 'itemId', v_it.id)));
        END IF;
    END IF;

    UPDATE public.intelligence_items
       SET review_state = 'accepted', applied_card_id = NULL, applied_mode = NULL, applied_at = NULL
     WHERE id = p_item;
    RETURN jsonb_build_object('item_id', p_item, 'review_state', 'accepted', 'unchanged', FALSE);
END;
$$;

-- ------------------------------------------------------------
-- 7. Privileges for the RPCs
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.persist_meeting_run(UUID, JSONB, JSONB, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.persist_project_brief(TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_intelligence_item(UUID, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_intelligence_item(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.undo_intelligence_item(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.persist_meeting_run(UUID, JSONB, JSONB, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.persist_project_brief(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_intelligence_item(UUID, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_intelligence_item(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.undo_intelligence_item(UUID, BOOLEAN) TO authenticated;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261118000500_intelligence_core')
ON CONFLICT (version) DO NOTHING;
