-- Isolated SQL integration checks for the protected morning assembly reset.
-- Runs only in the GitHub Actions test database.

DO $privileges$
BEGIN
  IF has_table_privilege('anon', 'public.morning_assembly_lateness', 'DELETE')
     OR has_table_privilege('authenticated', 'public.morning_assembly_lateness', 'DELETE')
     OR has_table_privilege('service_role', 'public.morning_assembly_lateness', 'DELETE')
     OR has_table_privilege('service_role', 'public.morning_assembly_lateness', 'TRUNCATE') THEN
    RAISE EXCEPTION 'direct delete/truncate access must remain unavailable';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.admin_delete_all_morning_assembly_lateness_records(text)', 'EXECUTE')
     OR has_function_privilege('anon',
      'public.admin_delete_all_morning_assembly_lateness_records(text)', 'EXECUTE')
     OR has_function_privilege('authenticated',
      'public.admin_delete_all_morning_assembly_lateness_records(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'reset RPC execution grants are incorrect';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
      WHERE oid = 'public.admin_delete_all_morning_assembly_lateness_records(text)'::regprocedure) THEN
    RAISE EXCEPTION 'reset RPC must execute as its trusted owner';
  END IF;
END
$privileges$;

BEGIN;
INSERT INTO public.morning_assembly_lateness
  (student_id, student_name_snapshot, class_name_snapshot, late_date, recorder_type, recorder_name, academic_year)
VALUES
  (987650001, 'Synthetic Reset Student 1', 'TEST/RESET', DATE '2026-11-18', 'admin', 'Synthetic Test', '2026/2027'),
  (987650002, 'Synthetic Reset Student 2', 'TEST/RESET', DATE '2026-11-19', 'teacher', 'Synthetic Test', '2026/2027');

SET LOCAL ROLE service_role;
DO $reset$
DECLARE
  v_result jsonb;
  v_count bigint;
BEGIN
  BEGIN
    PERFORM public.admin_delete_all_morning_assembly_lateness_records('مستخدم غير مخول');
    RAISE EXCEPTION 'unauthorized actor unexpectedly reset the ledger';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  v_result := public.admin_delete_all_morning_assembly_lateness_records('مدير النظام العام');
  IF v_result->>'ok' <> 'true' OR (v_result->>'deleted_records')::bigint <> 2 THEN
    RAISE EXCEPTION 'reset RPC returned an incorrect deletion count';
  END IF;
  SELECT count(*) INTO v_count FROM public.morning_assembly_lateness;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'morning assembly lateness records remain after reset';
  END IF;
END
$reset$;
RESET ROLE;
ROLLBACK;
SELECT 'protected morning assembly reset checks passed' AS result;
