DO $test$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.student_transfer_audit'::regclass) THEN
    RAISE EXCEPTION 'student transfer audit RLS is not enabled';
  END IF;
  IF has_table_privilege('anon','public.student_transfer_audit','SELECT')
     OR has_table_privilege('authenticated','public.student_transfer_audit','SELECT')
     OR has_table_privilege('anon','public.student_transfer_audit','INSERT')
     OR has_table_privilege('authenticated','public.student_transfer_audit','INSERT') THEN
    RAISE EXCEPTION 'browser roles can access the transfer audit table';
  END IF;
  IF has_function_privilege('anon','public.admin_transfer_student(text,text,text,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.admin_transfer_student(text,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.admin_transfer_student(text,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'student transfer RPC grants are not restricted to service_role';
  END IF;
END
$test$;

SET ROLE service_role;
SELECT public.admin_transfer_student(
  'student-transfer-test', '10/1', '10/2', 'synthetic-admin'
);

DO $verify$
DECLARE
  v_count integer;
  v_records jsonb;
  v_teacher text;
  v_class text;
  v_issue integer;
  v_delivered boolean;
  v_audit integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.students
  WHERE class_name='10/1' AND student_name='student-transfer-test';
  IF v_count <> 0 THEN RAISE EXCEPTION 'source roster membership was not removed'; END IF;

  SELECT count(*) INTO v_count FROM public.students
  WHERE class_name='10/2' AND student_name='student-transfer-test';
  IF v_count <> 1 THEN RAISE EXCEPTION 'destination roster membership was not created exactly once'; END IF;

  SELECT records, teacher_name INTO v_records, v_teacher FROM public.attendance
  WHERE record_key='2026-11-01_10/1_p1';
  IF v_records <> '{"source-peer":"present"}'::jsonb OR v_teacher <> 'source-teacher' THEN
    RAISE EXCEPTION 'source attendance peer data or teacher attribution changed';
  END IF;
  SELECT records, teacher_name INTO v_records, v_teacher FROM public.attendance
  WHERE record_key='2026-11-01_10/2_p1';
  IF v_records <> '{"destination-peer":"late","student-transfer-test":"absent"}'::jsonb
     OR v_teacher <> 'destination-teacher' THEN
    RAISE EXCEPTION 'destination attendance was not safely merged or teacher attribution changed';
  END IF;

  SELECT records, teacher_name INTO v_records, v_teacher FROM public.behaviors
  WHERE record_key='2026-11-01_10/1_p1';
  IF v_records <> '{"source-peer":{"type":"normal","note":""}}'::jsonb OR v_teacher <> 'source-teacher' THEN
    RAISE EXCEPTION 'source behavior peer data or teacher attribution changed';
  END IF;
  SELECT records, teacher_name INTO v_records, v_teacher FROM public.behaviors
  WHERE record_key='2026-11-01_10/2_p1';
  IF v_records <> '{"destination-peer":{"type":"late","note":"synthetic"},"student-transfer-test":{"type":"positive","note":"synthetic"}}'::jsonb
     OR v_teacher <> 'destination-teacher' THEN
    RAISE EXCEPTION 'destination behavior was not safely merged or teacher attribution changed';
  END IF;

  SELECT class_name, issue_number, delivered INTO v_class, v_issue, v_delivered
  FROM public.student_affairs_notice_issues
  WHERE student_name='student-transfer-test';
  IF v_class <> '10/2' OR v_issue <> 1 OR v_delivered IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'official notice class link or immutable notice details changed';
  END IF;

  SELECT count(*) INTO v_audit FROM public.student_transfer_audit
  WHERE student_name='student-transfer-test' AND from_class='10/1' AND to_class='10/2'
    AND attendance_records=1 AND behavior_records=1 AND notice_records=1
    AND transferred_by='synthetic-admin';
  IF v_audit <> 1 THEN RAISE EXCEPTION 'transfer audit record is missing or incorrect'; END IF;
END
$verify$;
RESET ROLE;

SELECT 'atomic student transfer integration checks passed' AS result;

-- Recovery path: destination membership already exists from a prior manual roster edit.
CREATE TEMP TABLE expected_transfer_destination AS
SELECT id FROM public.students
WHERE class_name='10/2' AND student_name='student-transfer-existing-destination';
SELECT public.admin_transfer_student('student-transfer-existing-destination','10/1','10/2','synthetic-admin');
DO $recovery_verify$
DECLARE v_count integer; v_expected_id bigint; v_actual_id bigint; v_records jsonb; v_class text; v_audit integer;
BEGIN
  SELECT id INTO v_expected_id FROM expected_transfer_destination;
  SELECT count(*) INTO v_count FROM public.students
  WHERE class_name='10/1' AND student_name='student-transfer-existing-destination';
  IF v_count <> 0 THEN RAISE EXCEPTION 'recovery left the stale source membership'; END IF;
  SELECT count(*),min(id) INTO v_count,v_actual_id FROM public.students
  WHERE class_name='10/2' AND student_name='student-transfer-existing-destination';
  IF v_count <> 1 OR v_actual_id <> v_expected_id THEN RAISE EXCEPTION 'existing destination membership was not preserved'; END IF;
  SELECT records INTO v_records FROM public.attendance WHERE record_key='2026-11-02_10/2_p2';
  IF v_records <> '{"destination-peer":"late","student-transfer-existing-destination":"absent"}'::jsonb THEN RAISE EXCEPTION 'recovery attendance merge failed'; END IF;
  SELECT records INTO v_records FROM public.attendance WHERE record_key='2026-11-02_10/1_p2';
  IF v_records <> '{"source-peer":"present"}'::jsonb THEN RAISE EXCEPTION 'recovery changed another student attendance'; END IF;
  SELECT records INTO v_records FROM public.behaviors WHERE record_key='2026-11-02_10/2_p2';
  IF v_records <> '{"destination-peer":{"type":"late","note":"synthetic"},"student-transfer-existing-destination":{"type":"positive","note":"synthetic"}}'::jsonb THEN RAISE EXCEPTION 'recovery behavior merge failed'; END IF;
  SELECT records INTO v_records FROM public.behaviors WHERE record_key='2026-11-02_10/1_p2';
  IF v_records <> '{"source-peer":{"type":"normal","note":""}}'::jsonb THEN RAISE EXCEPTION 'recovery changed another student behavior'; END IF;
  SELECT class_name INTO v_class FROM public.student_affairs_notice_issues WHERE student_name='student-transfer-existing-destination';
  IF v_class <> '10/2' THEN RAISE EXCEPTION 'recovery did not move official notice'; END IF;
  SELECT count(*) INTO v_audit FROM public.student_transfer_audit
  WHERE student_name='student-transfer-existing-destination' AND from_class='10/1' AND to_class='10/2'
    AND attendance_records=1 AND behavior_records=1 AND notice_records=1 AND transferred_by='synthetic-admin';
  IF v_audit <> 1 THEN RAISE EXCEPTION 'recovery audit record missing'; END IF;
END
$recovery_verify$;
SELECT 'existing-destination student transfer recovery checks passed' AS result;
