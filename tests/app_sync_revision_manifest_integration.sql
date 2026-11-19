-- Isolated integration checks for the app sync revision manifest.
-- All data mutations below run inside a transaction that is rolled back.
DO $test$
DECLARE
  manifest jsonb;
  base jsonb;
  expected integer;
  table_name text;
  suffix text := '__app_sync_revision_probe__';
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='private.app_sync_revisions'::regclass) THEN
    RAISE EXCEPTION 'RLS must be enabled on private.app_sync_revisions';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.get_app_sync_manifest()'::regprocedure) THEN
    RAISE EXCEPTION 'Manifest RPC must use invoker rights';
  END IF;
  IF NOT has_schema_privilege('anon','private','USAGE')
    OR NOT has_table_privilege('anon','private.app_sync_revisions','SELECT')
    OR has_table_privilege('anon','private.app_sync_revisions','INSERT')
    OR has_table_privilege('anon','private.app_sync_revisions','UPDATE')
    OR has_table_privilege('anon','private.app_sync_revisions','DELETE') THEN
    RAISE EXCEPTION 'Unexpected anon privileges on revision metadata';
  END IF;
  IF NOT has_function_privilege('anon','public.get_app_sync_manifest()','EXECUTE')
    OR has_function_privilege('anon','private.bump_app_sync_revision()','EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected anon function privileges';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
        AND t.tgname LIKE 'app_sync_revision_%'
        AND NOT t.tgisinternal
        AND t.tgenabled='O') <> 7 THEN
    RAISE EXCEPTION 'Expected exactly seven enabled revision triggers';
  END IF;
  SELECT public.get_app_sync_manifest() INTO manifest;
  IF jsonb_object_length(manifest) <> 7
    OR NOT (manifest ?& ARRAY['classes','students','teachers','attendance','behaviors','school_settings','duty_reports']) THEN
    RAISE EXCEPTION 'Manifest must expose exactly the seven synchronized tables';
  END IF;
END
$test$;

-- Exercise the RPC as the same role used by unauthenticated browser clients.
SET ROLE anon;
DO $anon_test$
DECLARE manifest jsonb;
BEGIN
  manifest := public.get_app_sync_manifest();
  IF jsonb_object_length(manifest) <> 7 THEN
    RAISE EXCEPTION 'anon cannot read the complete manifest';
  END IF;
  IF (SELECT count(*) FROM private.app_sync_revisions) <> 7 THEN
    RAISE EXCEPTION 'anon cannot read revision metadata';
  END IF;
END
$anon_test$;
RESET ROLE;

BEGIN;
DO $trigger_test$
DECLARE
  base jsonb;
  expected integer;
  tbl text;
  suffix text := '__app_sync_revision_probe__';
BEGIN
  SELECT jsonb_object_agg(table_name, revision) INTO base
  FROM private.app_sync_revisions;

  INSERT INTO public.classes(name) VALUES (suffix);
  INSERT INTO public.students(class_name, student_name) VALUES (suffix, suffix);
  INSERT INTO public.teachers(name, role, permissions) VALUES (suffix, 'teacher', '{}'::jsonb);
  INSERT INTO public.attendance(record_key, date_str, class_name, period, records)
    VALUES (suffix, current_date, suffix, 1, '{}'::jsonb);
  INSERT INTO public.behaviors(record_key, date_str, class_name, period, records)
    VALUES (suffix, current_date, suffix, 1, '{}'::jsonb);
  INSERT INTO public.school_settings(key, value) VALUES (suffix, '{}'::jsonb);
  INSERT INTO public.duty_reports(id, date_str) VALUES (suffix, current_date::text);

  FOREACH tbl IN ARRAY ARRAY['classes','students','teachers','attendance','behaviors','school_settings','duty_reports'] LOOP
    SELECT (base->>tbl)::integer + 1 INTO expected;
    IF (SELECT revision FROM private.app_sync_revisions WHERE table_name=tbl) <> expected THEN
      RAISE EXCEPTION 'INSERT did not increment revision for %', tbl;
    END IF;
  END LOOP;

  UPDATE public.classes SET name=suffix || '_updated' WHERE name=suffix;
  UPDATE public.students SET student_name=suffix || '_updated' WHERE student_name=suffix;
  UPDATE public.teachers SET permissions='{"probe":true}'::jsonb WHERE name=suffix;
  UPDATE public.attendance SET records='{"probe":true}'::jsonb WHERE record_key=suffix;
  UPDATE public.behaviors SET records='{"probe":true}'::jsonb WHERE record_key=suffix;
  UPDATE public.school_settings SET value='{"probe":true}'::jsonb WHERE key=suffix;
  UPDATE public.duty_reports SET status='reviewed' WHERE id=suffix;

  FOREACH tbl IN ARRAY ARRAY['classes','students','teachers','attendance','behaviors','school_settings','duty_reports'] LOOP
    SELECT (base->>tbl)::integer + 2 INTO expected;
    IF (SELECT revision FROM private.app_sync_revisions WHERE table_name=tbl) <> expected THEN
      RAISE EXCEPTION 'UPDATE did not increment revision for %', tbl;
    END IF;
  END LOOP;

  DELETE FROM public.classes WHERE name=suffix || '_updated';
  DELETE FROM public.students WHERE student_name=suffix || '_updated';
  DELETE FROM public.teachers WHERE name=suffix;
  DELETE FROM public.attendance WHERE record_key=suffix;
  DELETE FROM public.behaviors WHERE record_key=suffix;
  DELETE FROM public.school_settings WHERE key=suffix;
  DELETE FROM public.duty_reports WHERE id=suffix;

  FOREACH tbl IN ARRAY ARRAY['classes','students','teachers','attendance','behaviors','school_settings','duty_reports'] LOOP
    SELECT (base->>tbl)::integer + 3 INTO expected;
    IF (SELECT revision FROM private.app_sync_revisions WHERE table_name=tbl) <> expected THEN
      RAISE EXCEPTION 'DELETE did not increment revision for %', tbl;
    END IF;
  END LOOP;
END
$trigger_test$;
ROLLBACK;

DO $rollback_test$
BEGIN
  IF EXISTS (SELECT 1 FROM public.classes WHERE name LIKE '__app_sync_revision_probe__%')
    OR EXISTS (SELECT 1 FROM public.students WHERE student_name LIKE '__app_sync_revision_probe__%')
    OR EXISTS (SELECT 1 FROM public.teachers WHERE name LIKE '__app_sync_revision_probe__%')
    OR EXISTS (SELECT 1 FROM public.attendance WHERE record_key LIKE '__app_sync_revision_probe__%')
    OR EXISTS (SELECT 1 FROM public.behaviors WHERE record_key LIKE '__app_sync_revision_probe__%')
    OR EXISTS (SELECT 1 FROM public.school_settings WHERE key LIKE '__app_sync_revision_probe__%')
    OR EXISTS (SELECT 1 FROM public.duty_reports WHERE id LIKE '__app_sync_revision_probe__%') THEN
    RAISE EXCEPTION 'Synthetic integration records survived rollback';
  END IF;
END
$rollback_test$;

SELECT 'app sync revision manifest integration checks passed' AS result;
