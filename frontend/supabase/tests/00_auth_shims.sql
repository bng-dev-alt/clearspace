-- Test-only shims so a plain supabase/postgres container behaves like a full
-- Supabase project (GoTrue normally provides these). NOT part of the product.
-- Never applied to a real Supabase stack (there auth.uid()/auth.jwt() are the real ones).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated;


-- Storage stand-in for the plain-Postgres harness: the supabase/postgres image has an EMPTY `storage` schema
-- (the real tables come from the Storage API service). Only created when absent, so a real stack keeps its own.
-- Owned by postgres so the non-superuser hosted-role scenario can create policies on it (on the real hosted
-- project postgres may do that too -- verified with a rolled-back probe).
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY, name text NOT NULL UNIQUE, owner uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text,
      owner uuid, created_at timestamptz DEFAULT now(), metadata jsonb);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $f$
      DECLARE _parts text[];
      BEGIN SELECT string_to_array(name, '/') INTO _parts; RETURN _parts[1:array_length(_parts, 1) - 1]; END $f$;
    GRANT USAGE ON SCHEMA storage TO anon, authenticated, postgres;
    GRANT ALL ON storage.buckets, storage.objects TO postgres;
    GRANT SELECT, INSERT, DELETE ON storage.objects TO authenticated;
    ALTER TABLE storage.buckets OWNER TO postgres;
    ALTER TABLE storage.objects OWNER TO postgres;
  END IF;
END $$;
