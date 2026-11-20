-- Isolated integration checks for general app sessions.
-- Runs only against the disposable PostgreSQL database created by CI.
DO $do$
DECLARE
  v_columns text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.app_sessions'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'app_sessions RLS must be enabled';
  END IF;

  SELECT array_agg(attname::text ORDER BY attnum)
    INTO v_columns
    FROM pg_attribute
   WHERE attrelid = 'public.app_sessions'::regclass
     AND attnum > 0 AND NOT attisdropped;

  IF v_columns IS DISTINCT FROM ARRAY[
    'token_hash','principal_type','principal_name','expires_at','created_at'
  ]::text[] THEN
    RAISE EXCEPTION 'app_sessions schema changed unexpectedly: %', v_columns;
  END IF;

  IF has_table_privilege('anon','public.app_sessions','SELECT')
    OR has_table_privilege('anon','public.app_sessions','INSERT')
    OR has_table_privilege('anon','public.app_sessions','UPDATE')
    OR has_table_privilege('anon','public.app_sessions','DELETE')
    OR has_table_privilege('authenticated','public.app_sessions','SELECT')
    OR has_table_privilege('authenticated','public.app_sessions','INSERT')
    OR has_table_privilege('authenticated','public.app_sessions','UPDATE')
    OR has_table_privilege('authenticated','public.app_sessions','DELETE') THEN
    RAISE EXCEPTION 'browser roles have direct app_sessions privileges';
  END IF;

  IF NOT has_table_privilege('service_role','public.app_sessions','SELECT')
    OR NOT has_table_privilege('service_role','public.app_sessions','INSERT')
    OR NOT has_table_privilege('service_role','public.app_sessions','DELETE') THEN
    RAISE EXCEPTION 'service_role is missing required session store privileges';
  END IF;
END $do$;

-- Use deterministic, synthetic SHA-256-shaped values only. No school account,
-- live bearer token, or production record is involved.
SET ROLE service_role;
INSERT INTO public.app_sessions(token_hash,principal_type,principal_name,expires_at)
VALUES
  (repeat('a',64),'teacher','synthetic-teacher-a',now() + interval '1 hour'),
  (repeat('b',64),'teacher','synthetic-teacher-b',now() + interval '1 hour');

DO $do$
DECLARE
  v_count integer;
  v_names text[];
BEGIN
  SELECT count(*), array_agg(principal_name ORDER BY principal_name)
    INTO v_count, v_names
    FROM public.app_sessions
   WHERE token_hash IN (repeat('a',64), repeat('b',64));

  IF v_count <> 2 OR v_names IS DISTINCT FROM ARRAY[
    'synthetic-teacher-a','synthetic-teacher-b'
  ]::text[] THEN
    RAISE EXCEPTION 'synthetic session insert/read verification failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.app_sessions
    WHERE token_hash IN (repeat('a',64), repeat('b',64))
      AND length(token_hash) <> 64
  ) THEN
    RAISE EXCEPTION 'session token digest shape is invalid';
  END IF;
END $do$;

DELETE FROM public.app_sessions WHERE token_hash = repeat('a',64);
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_sessions WHERE token_hash = repeat('a',64))
    OR NOT EXISTS (SELECT 1 FROM public.app_sessions WHERE token_hash = repeat('b',64)) THEN
    RAISE EXCEPTION 'single-session revocation affected the wrong session';
  END IF;
END $do$;
DELETE FROM public.app_sessions WHERE token_hash = repeat('b',64);
RESET ROLE;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_sessions
    WHERE principal_name LIKE 'synthetic-teacher-%') THEN
    RAISE EXCEPTION 'synthetic app session cleanup failed';
  END IF;
END $do$;

SELECT 'isolated app session schema, privilege, insert, lookup, revocation, and cleanup checks passed' AS result;
