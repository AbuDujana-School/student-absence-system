DO $$
DECLARE
  v_cancel text := pg_get_functiondef('public.cancel_timetable_substitution(jsonb)'::regprocedure);
  v_replace text := pg_get_functiondef('public.replace_timetable_substitution_with_reason(jsonb)'::regprocedure);
  v_reassign text := pg_get_functiondef('public.reassign_timetable_substitution_absent_with_reason(jsonb)'::regprocedure);
  v_batch text := pg_get_functiondef('public.replace_timetable_substitution_batch_with_reason(jsonb)'::regprocedure);
BEGIN
  IF position('Asia/Muscat' in v_cancel)=0
    OR position('assignment_date is distinct from' in v_cancel)=0 THEN
    RAISE EXCEPTION 'Single cancellation must be restricted to the current Muscat calendar day.';
  END IF;
  IF position('Asia/Muscat' in v_replace)=0
    OR position('assignment_date is distinct from' in v_replace)=0 THEN
    RAISE EXCEPTION 'Single-record edits must be restricted to the current Muscat calendar day.';
  END IF;
  IF position('20 hours' in v_replace)>0 OR position('20-hour' in v_replace)>0 THEN
    RAISE EXCEPTION 'The rolling 20-hour edit window must be removed.';
  END IF;
  IF position('v_period' in v_replace)=0 OR position('v_absent_name' in v_replace)=0 THEN
    RAISE EXCEPTION 'Single-record edit must support changing the absent teacher and period.';
  END IF;
  IF position('absent_teacher_name' in v_reassign)=0 OR position('period' in v_reassign)=0 THEN
    RAISE EXCEPTION 'Absent-teacher reassignment must forward the edited period.';
  END IF;
  IF position('period' in v_batch)=0 OR position('absentTeacherName' in v_batch)=0 THEN
    RAISE EXCEPTION 'Batch edits must forward optional absent-teacher and period changes.';
  END IF;
  IF NOT has_function_privilege('service_role','public.replace_timetable_substitution_with_reason(jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.replace_timetable_substitution_with_reason(jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.replace_timetable_substitution_with_reason(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'Reserve edit RPC privileges are not restricted to service_role.';
  END IF;
END;
$$;
