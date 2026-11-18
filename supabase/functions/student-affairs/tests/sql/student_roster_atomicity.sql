DO $test$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.student_roster_audit'::regclass) THEN
    RAISE EXCEPTION 'student roster audit RLS is not enabled';
  END IF;
  IF has_table_privilege('anon','public.student_roster_audit','SELECT')
     OR has_table_privilege('authenticated','public.student_roster_audit','INSERT')
     OR has_function_privilege('anon','public.admin_save_student_roster(text,jsonb,text)','EXECUTE')
     OR has_function_privilege('authenticated','public.admin_save_student_roster(text,jsonb,text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.admin_save_student_roster(text,jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION 'student roster save access is not restricted to service_role';
  END IF;
END
$test$;

SET ROLE service_role;

INSERT INTO public.students(class_name,student_name)
VALUES ('10/1','student-roster-remove-test'),('10/1','student-roster-keep-test')
ON CONFLICT (class_name,student_name) DO NOTHING;

INSERT INTO public.attendance(record_key,date_str,class_name,period,teacher_name,records)
VALUES (
  '2026-11-03_10/1_p3','2026-11-03','10/1',3,'synthetic-teacher',
  '{"student-roster-remove-test":"absent","student-roster-keep-test":"late","roster-peer":"present"}'::jsonb
)
ON CONFLICT (record_key) DO UPDATE SET records=EXCLUDED.records;

INSERT INTO public.behaviors(record_key,date_str,class_name,period,teacher_name,records)
VALUES (
  '2026-11-03_10/1_p3','2026-11-03','10/1',3,'synthetic-teacher',
  '{"student-roster-remove-test":{"type":"positive","note":"synthetic preserved note"},"student-roster-keep-test":{"type":"late","note":"keep this"},"roster-peer":{"type":"normal","note":""}}'::jsonb
)
ON CONFLICT (record_key) DO UPDATE SET records=EXCLUDED.records;

SELECT public.admin_save_student_roster(
  '10/1',
  '["student-roster-keep-test","student-roster-added-test"]'::jsonb,
  'synthetic-admin'
);

DO $verify$
DECLARE
  v_count integer;
  v_records jsonb;
  v_result jsonb;
  v_added integer;
  v_removed integer;
  v_total integer;
  v_audit_added integer;
  v_audit_removed integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.students
  WHERE class_name='10/1' AND student_name='student-roster-remove-test';
  IF v_count <> 0 THEN RAISE EXCEPTION 'removed student is still in the roster'; END IF;

  SELECT count(*) INTO v_count FROM public.students
  WHERE class_name='10/1' AND student_name='student-roster-keep-test';
  IF v_count <> 1 THEN RAISE EXCEPTION 'retained student membership changed'; END IF;

  SELECT count(*) INTO v_count FROM public.students
  WHERE class_name='10/1' AND student_name='student-roster-added-test';
  IF v_count <> 1 THEN RAISE EXCEPTION 'new student membership was not saved'; END IF;

  SELECT records INTO v_records FROM public.attendance
  WHERE record_key='2026-11-03_10/1_p3';
  IF v_records <> '{"student-roster-remove-test":"absent","student-roster-keep-test":"late","roster-peer":"present"}'::jsonb THEN
    RAISE EXCEPTION 'roster save modified attendance or another student record';
  END IF;

  SELECT records INTO v_records FROM public.behaviors
  WHERE record_key='2026-11-03_10/1_p3';
  IF v_records <> '{"student-roster-remove-test":{"type":"positive","note":"synthetic preserved note"},"student-roster-keep-test":{"type":"late","note":"keep this"},"roster-peer":{"type":"normal","note":""}}'::jsonb THEN
    RAISE EXCEPTION 'roster save modified behavior notes or another student record';
  END IF;

  SELECT count(*) INTO v_audit_added FROM public.student_roster_audit
  WHERE class_name='10/1' AND student_name='student-roster-added-test'
    AND action='added' AND actor_name='synthetic-admin';
  SELECT count(*) INTO v_audit_removed FROM public.student_roster_audit
  WHERE class_name='10/1' AND student_name='student-roster-remove-test'
    AND action='removed' AND actor_name='synthetic-admin';
  IF v_audit_added <> 1 OR v_audit_removed <> 1 THEN
    RAISE EXCEPTION 'student roster audit entries are incomplete';
  END IF;

  v_result := public.admin_save_student_roster(
    '10/1',
    '["student-roster-keep-test","student-roster-added-test"]'::jsonb,
    'synthetic-admin'
  );
  v_added := (v_result->>'added_count')::integer;
  v_removed := (v_result->>'removed_count')::integer;
  v_total := (v_result->>'total_count')::integer;
  IF v_added <> 0 OR v_removed <> 0 OR v_total <> 2 THEN
    RAISE EXCEPTION 'repeating the same roster save is not idempotent';
  END IF;
END
$verify$;

RESET ROLE;
SELECT 'direct student roster save and history-retention checks passed' AS result;
