-- ============================================================
-- 20261117000200 -- Atomic, project-scoped board restore (AI History)
--
-- The old client-side restore deleted every column/card of the project and then
-- re-inserted them card by card; any failure half-way left an EMPTY board, and
-- its project-list branch deleted every visible project missing from the
-- snapshot. This RPC replaces the board of ONE project in a single transaction
-- (a function call is atomic: any error rolls everything back).
--
--  * SECURITY INVOKER: RLS still applies to every statement.
--  * Only the project OWNER may restore (wiping a shared board is not a member action).
--  * It touches exactly one project; nothing else is read, changed or deleted.
-- Idempotent (CREATE OR REPLACE). Apply after 20261117000100.
-- ============================================================

CREATE OR REPLACE FUNCTION public.restore_project_board(p_project_id TEXT, p_board JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_col JSONB;
    v_card JSONB;
    v_ci INTEGER := 0;
    v_ki INTEGER;
    v_cols INTEGER := 0;
    v_cards INTEGER := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    IF p_project_id IS NULL OR NOT public.is_project_owner(p_project_id) THEN
        RAISE EXCEPTION 'Board může obnovit jen vlastník projektu.' USING ERRCODE = '42501';
    END IF;
    IF p_board IS NULL OR jsonb_typeof(p_board -> 'columns') <> 'array'
       OR jsonb_array_length(p_board -> 'columns') > 50 THEN
        RAISE EXCEPTION 'Neplatná záloha boardu.' USING ERRCODE = '22023';
    END IF;
    IF (SELECT coalesce(sum(jsonb_array_length(coalesce(c -> 'cards', '[]'::jsonb))), 0)
        FROM jsonb_array_elements(p_board -> 'columns') c) > 2000 THEN
        RAISE EXCEPTION 'Záloha boardu je příliš velká.' USING ERRCODE = '22023';
    END IF;

    -- Cards and their checklists/comments/activities/assignees go with the columns (ON DELETE CASCADE).
    DELETE FROM public.columns WHERE project_id = p_project_id;

    FOR v_col IN SELECT * FROM jsonb_array_elements(p_board -> 'columns') LOOP
        INSERT INTO public.columns (id, project_id, name, position)
        VALUES (v_col ->> 'id', p_project_id, v_col ->> 'name', v_ci);
        v_ci := v_ci + 1;
        v_cols := v_cols + 1;
        v_ki := 0;

        FOR v_card IN SELECT * FROM jsonb_array_elements(coalesce(v_col -> 'cards', '[]'::jsonb)) LOOP
            INSERT INTO public.cards
                (id, column_id, title, details, tag, priority, assignee_name, assignee_initials,
                 assignee_color, assignees, due_date, position, archived, created_at, updated_at)
            VALUES
                (v_card ->> 'id', v_col ->> 'id', v_card ->> 'title', coalesce(v_card ->> 'details', ''),
                 v_card ->> 'tag', v_card ->> 'priority', v_card ->> 'assignee_name',
                 v_card ->> 'assignee_initials', v_card ->> 'assignee_color',
                 nullif(v_card -> 'assignees', 'null'::jsonb), v_card ->> 'due_date', v_ki,
                 coalesce((v_card ->> 'archived')::boolean, false),
                 coalesce((v_card ->> 'created_at')::timestamptz, now()),
                 coalesce((v_card ->> 'updated_at')::timestamptz, now()));
            v_ki := v_ki + 1;
            v_cards := v_cards + 1;

            INSERT INTO public.task_checklists (id, card_id, text, completed)
            SELECT i ->> 'id', v_card ->> 'id', i ->> 'text', coalesce((i ->> 'completed')::boolean, false)
            FROM jsonb_array_elements(coalesce(v_card -> 'checklist', '[]'::jsonb)) i;

            INSERT INTO public.task_comments (id, card_id, author_name, content, created_at)
            SELECT i ->> 'id', v_card ->> 'id', i ->> 'author_name', i ->> 'content',
                   coalesce((i ->> 'created_at')::timestamptz, now())
            FROM jsonb_array_elements(coalesce(v_card -> 'comments', '[]'::jsonb)) i;

            INSERT INTO public.task_activities (id, card_id, text, created_at)
            SELECT i ->> 'id', v_card ->> 'id', i ->> 'text',
                   coalesce((i ->> 'created_at')::timestamptz, now())
            FROM jsonb_array_elements(coalesce(v_card -> 'activities', '[]'::jsonb)) i;

            -- Only members that still exist AND are visible to the caller (RLS) are re-linked.
            INSERT INTO public.card_assignees (card_id, member_id, position)
            SELECT v_card ->> 'id', wm.id, (a.ord - 1)::integer
            FROM jsonb_array_elements_text(coalesce(v_card -> 'assignee_ids', '[]'::jsonb))
                 WITH ORDINALITY AS a(member_id, ord)
            JOIN public.workspace_members wm ON wm.id = a.member_id
            ON CONFLICT DO NOTHING;
        END LOOP;
    END LOOP;

    RETURN jsonb_build_object('columns', v_cols, 'cards', v_cards);
END;
$$;

REVOKE ALL ON FUNCTION public.restore_project_board(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_project_board(TEXT, JSONB) TO authenticated;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261117000200_restore_project_board')
ON CONFLICT (version) DO NOTHING;
