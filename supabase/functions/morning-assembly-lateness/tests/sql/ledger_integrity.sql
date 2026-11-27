-- Isolated PostgreSQL integration checks for the morning assembly lateness ledger.
-- This file runs only in the GitHub Actions test database, never against the school project.

DO $checks$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.morning_assembly_lateness'::regclass) THEN
    RAISE EXCEPTION 'lateness ledger RLS is not enabled';
  END IF;

  IF has_table_privilege('anon', 'public.morning_assembly_lateness', 'SELECT')
     OR has_table_privilege('anon', 'public.morning_assembly_lateness', 'INSERT')
     OR has_table_privilege('authenticated', 'public.morning_assembly_lateness', 'SELECT')
     OR has_table_privilege('authenticated', 'public.morning_assembly_lateness', 'INSERT') THEN
    RAISE EXCEPTION 'browser roles can access the lateness ledger';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.morning_assembly_lateness', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.morning_assembly_lateness', 'INSERT')
     OR has_table_privilege('service_role', 'public.morning_assembly_lateness', 'UPDATE')
     OR has_table_privilege('service_role', 'public.morning_assembly_lateness', 'DELETE')
     OR has_table_privilege('service_role', 'public.morning_assembly_lateness', 'TRUNCATE') THEN
    RAISE EXCEPTION 'lateness ledger is not append-only for service_role';
  END IF;

  IF has_function_privilege('anon', 'public.delete_morning_assembly_lateness_record(uuid,bigint,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.delete_morning_assembly_lateness_record(uuid,bigint,date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.delete_morning_assembly_lateness_record(uuid,bigint,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'scoped lateness cancellation RPC privileges are not service-role-only';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'morning_assembly_lateness_student_day_uidx'
      AND indexdef ILIKE '%UNIQUE%'
  ) THEN
    RAISE EXCEPTION 'unique student/day index is missing';
  END IF;
END
$checks$;

BEGIN;
INSERT INTO public.students(id, class_name, student_name)
VALUES (987654321, 'TEST/1', 'Synthetic Lateness Student');

SET LOCAL ROLE service_role;
DO $ledger$
DECLARE
  v_duplicate_blocked boolean := false;
  v_wrong_period_blocked boolean := false;
  v_wrong_year_blocked boolean := false;
  v_delete_id uuid;
  v_result jsonb;
BEGIN
  INSERT INTO public.morning_assembly_lateness
    (student_id, student_name_snapshot, class_name_snapshot, late_date, recorder_type, recorder_name, academic_year)
  VALUES
    (987654321, 'Synthetic Lateness Student', 'TEST/1', DATE '2026-11-18', 'admin', 'Synthetic Test', '2026/2027');

  BEGIN
    INSERT INTO public.morning_assembly_lateness
      (student_id, student_name_snapshot, class_name_snapshot, late_date, recorder_type, recorder_name, academic_year)
    VALUES
      (987654321, 'Synthetic Lateness Student', 'TEST/1', DATE '2026-11-18', 'admin', 'Synthetic Test', '2026/2027');
  EXCEPTION WHEN unique_violation THEN
    v_duplicate_blocked := true;
  END;
  IF NOT v_duplicate_blocked THEN
    RAISE EXCEPTION 'duplicate student/day record was not blocked';
  END IF;

  BEGIN
    INSERT INTO public.morning_assembly_lateness
      (student_id, student_name_snapshot, class_name_snapshot, late_date, recorder_type, recorder_name, academic_year)
    VALUES
      (987654322, 'Synthetic Lateness Student 2', 'TEST/1', DATE '2026-08-31', 'admin', 'Synthetic Test', '2026/2027');
  EXCEPTION WHEN check_violation THEN
    v_wrong_period_blocked := true;
  END;
  IF NOT v_wrong_period_blocked THEN
    RAISE EXCEPTION 'date outside the academic period was not blocked';
  END IF;

  BEGIN
    INSERT INTO public.morning_assembly_lateness
      (student_id, student_name_snapshot, class_name_snapshot, late_date, recorder_type, recorder_name, academic_year)
    VALUES
      (987654323, 'Synthetic Lateness Student 3', 'TEST/1', DATE '2026-11-18', 'admin', 'Synthetic Test', '2026/2028');
  EXCEPTION WHEN check_violation THEN
    v_wrong_year_blocked := true;
  END;
  IF NOT v_wrong_year_blocked THEN
    RAISE EXCEPTION 'invalid academic year sequence was not blocked';
  END IF;

  INSERT INTO public.morning_assembly_lateness
    (student_id, student_name_snapshot, class_name_snapshot, late_date, recorder_type, recorder_name, academic_year)
  VALUES
    (987654321, 'Synthetic Lateness Student', 'TEST/1', DATE '2026-11-19', 'admin', 'Synthetic Test', '2026/2027');

  SELECT id INTO v_delete_id
  FROM public.morning_assembly_lateness
  WHERE student_id = 987654321 AND late_date = DATE '2026-11-19';

  v_result := public.delete_morning_assembly_lateness_record(
    v_delete_id, 987654322, DATE '2026-11-19'
  );
  IF v_result->>'ok' <> 'false' OR (v_result->>'deleted_records')::integer <> 0 THEN
    RAISE EXCEPTION 'scoped cancellation accepted a mismatched student id';
  END IF;

  v_result := public.delete_morning_assembly_lateness_record(
    v_delete_id, 987654321, DATE '2026-11-20'
  );
  IF v_result->>'ok' <> 'false' OR (v_result->>'deleted_records')::integer <> 0 THEN
    RAISE EXCEPTION 'scoped cancellation accepted a mismatched school date';
  END IF;

  v_result := public.delete_morning_assembly_lateness_record(
    v_delete_id, 987654321, DATE '2026-11-19'
  );
  IF v_result->>'ok' <> 'true' OR (v_result->>'deleted_records')::integer <> 1 THEN
    RAISE EXCEPTION 'scoped cancellation did not delete exactly one matching record';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.morning_assembly_lateness
    WHERE student_id = 987654321 AND late_date = DATE '2026-11-19'
  ) THEN
    RAISE EXCEPTION 'scoped cancellation left the selected test record behind';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.morning_assembly_lateness
    WHERE student_id = 987654321 AND late_date = DATE '2026-11-18'
  ) THEN
    RAISE EXCEPTION 'scoped cancellation changed a different date record';
  END IF;
END
$ledger$;
RESET ROLE;

-- Student roster changes must not rewrite or cascade-delete immutable snapshots.
UPDATE public.students SET class_name = 'TEST/2' WHERE id = 987654321;
DO $snapshot$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.morning_assembly_lateness
    WHERE student_id = 987654321
      AND class_name_snapshot = 'TEST/1'
      AND student_name_snapshot = 'Synthetic Lateness Student'
  ) THEN
    RAISE EXCEPTION 'student transfer changed the historical lateness snapshot';
  END IF;
END
$snapshot$;
DELETE FROM public.students WHERE id = 987654321;
DO $preservation$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.morning_assembly_lateness
    WHERE student_id = 987654321 AND late_date = DATE '2026-11-18'
  ) THEN
    RAISE EXCEPTION 'roster deletion removed the historical lateness record';
  END IF;
END
$preservation$;

ROLLBACK;
SELECT 'isolated morning assembly lateness ledger integration checks passed' AS result;
