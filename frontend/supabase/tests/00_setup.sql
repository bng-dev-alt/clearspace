-- Test-only shims so a plain supabase/postgres container behaves like a full
-- Supabase project (GoTrue normally provides these). NOT part of the product.
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

CREATE SCHEMA IF NOT EXISTS test;
GRANT USAGE ON SCHEMA test TO anon, authenticated;

-- Impersonation helpers (SET LOCAL => scoped to the transaction).
CREATE OR REPLACE FUNCTION test.act_as(p_uid uuid, p_email text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'email', p_email, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  EXECUTE 'set local role authenticated';
END $$;
CREATE OR REPLACE FUNCTION test.act_as_anon() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE 'set local role anon';
END $$;
CREATE OR REPLACE FUNCTION test.reset() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'reset role';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;

CREATE OR REPLACE FUNCTION test.ok(p_cond boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF;
  RAISE NOTICE 'ok - %', p_msg;
END $$;

-- Statement must fail. p_state = expected SQLSTATE (or NULL = any); p_like = optional message substring.
-- Runs in a sub-transaction so a failure does not poison the caller's transaction.
CREATE OR REPLACE FUNCTION test.throws(p_sql text, p_state text, p_msg text, p_like text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_state text; v_err text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'ASSERTION FAILED: expected error but succeeded: %', p_msg;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
    IF v_err LIKE 'ASSERTION FAILED:%' THEN RAISE; END IF;
    IF p_state IS NOT NULL AND v_state <> p_state THEN
      RAISE EXCEPTION 'ASSERTION FAILED: % -- expected SQLSTATE %, got % (%)', p_msg, p_state, v_state, v_err;
    END IF;
    IF p_like IS NOT NULL AND v_err NOT LIKE '%' || p_like || '%' THEN
      RAISE EXCEPTION 'ASSERTION FAILED: % -- message "%" lacks "%"', p_msg, v_err, p_like;
    END IF;
  END;
  RAISE NOTICE 'ok - %', p_msg;
END $$;

-- Scalar query helper (run as the CURRENT role, so RLS applies).
CREATE OR REPLACE FUNCTION test.scalar(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN EXECUTE p_sql INTO v; RETURN v; END $$;

-- Create a confirmed user (as superuser; the signup trigger makes profile + owner member).
CREATE OR REPLACE FUNCTION test.mkuser(p_email text, p_confirmed boolean DEFAULT true) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  VALUES (v_id, p_email, CASE WHEN p_confirmed THEN now() END, jsonb_build_object('display_name', split_part(p_email,'@',1)));
  RETURN v_id;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA test TO anon, authenticated;
