-- ============================================================
-- 20261117000400 -- Task attachments: private Storage bucket + membership-based policies
--
-- The app uploads task files to a bucket called `task-resources` but no migration ever created it
-- (it used to be a manually created, PUBLIC bucket read through getPublicUrl()). Fresh projects have
-- no bucket, so uploads silently fell back to a local object URL.
--
--  * Bucket is PRIVATE; reads go through short-lived signed URLs (see resourceService).
--  * 10 MiB per file and an explicit MIME allow-list enforced by Storage itself (no SVG/HTML/scripts:
--    a file served from the project's own domain must not be able to run script).
--  * Object path is `tasks/<card id>/<file>`. Policies let a user read/upload/delete only when they are a
--    member of the project that owns that card (the same rule as public.task_resources). No UPDATE policy:
--    files are immutable (the client uses unique names and no upsert).
--  * anon gets nothing.
-- Idempotent. Apply after 20261117000100.
-- ============================================================

DO $$
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261117000100_security_foundation') THEN
        RAISE EXCEPTION 'Preflight failed -- apply 20261117000100_security_foundation first';
    END IF;
    IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed -- the Storage schema is not initialised (storage.buckets / storage.objects missing)';
    END IF;
    IF to_regprocedure('public.is_project_member(text)') IS NULL OR to_regprocedure('storage.foldername(text)') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed -- public.is_project_member(text) or storage.foldername(text) missing';
    END IF;
END $$;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'task-resources', 'task-resources', false, 10485760,
    ARRAY[
        'image/png', 'image/jpeg', 'image/gif', 'image/webp',
        'application/pdf',
        'text/plain', 'text/csv', 'text/markdown', 'application/json',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ]
)
ON CONFLICT (id) DO UPDATE
   SET public = false,
       file_size_limit = EXCLUDED.file_size_limit,
       allowed_mime_types = EXCLUDED.allowed_mime_types;

-- SECURITY INVOKER: evaluated under the caller's own RLS, so a non-member cannot even see the card.
CREATE OR REPLACE FUNCTION public.can_access_task_file(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((storage.foldername(p_name))[1] = 'tasks', false)
       AND EXISTS (
            SELECT 1
            FROM public.cards c
            JOIN public.columns col ON col.id = c.column_id
            WHERE c.id = (storage.foldername(p_name))[2]
              AND public.is_project_member(col.project_id)
       );
$$;
REVOKE ALL ON FUNCTION public.can_access_task_file(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_task_file(TEXT) TO authenticated;

DROP POLICY IF EXISTS "task_resources_files_select" ON storage.objects;
CREATE POLICY "task_resources_files_select" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'task-resources' AND public.can_access_task_file(name));

DROP POLICY IF EXISTS "task_resources_files_insert" ON storage.objects;
CREATE POLICY "task_resources_files_insert" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'task-resources' AND public.can_access_task_file(name));

DROP POLICY IF EXISTS "task_resources_files_delete" ON storage.objects;
CREATE POLICY "task_resources_files_delete" ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'task-resources' AND public.can_access_task_file(name));

INSERT INTO public.clearspace_migrations (version) VALUES ('20261117000400_task_resources_storage')
ON CONFLICT (version) DO NOTHING;
