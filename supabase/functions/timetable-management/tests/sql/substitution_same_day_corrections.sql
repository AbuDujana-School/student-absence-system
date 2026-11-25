DO $$
DECLARE
  v_cancel text := pg_get_functiondef('public.cancel_timetable_substitution(jsonb)'::regprocedure);
  v_replace text := pg_get_functiondef('public.replace_timetable_substitution_with_reason(jsonb)'::regprocedure);
  v_reassign text := pg_get_functiondef('public.reassign_timetable_substitution_absent_with_reason(jsonb)'::regprocedure);
  v_batch text := pg_get_functiondef('public.replace_timetable_substitution_batch_with_reason(jsonb)'::regprocedure);
  v_day_window text := pg_get_functiondef('public.timetable_substitution_assignment_editable_until_day_end(date)'::regprocedure);
BEGIN
  IF position('timetable_substitution_assignment_editable_until_day_end' in v_cancel)=0 THEN
    RAISE EXCEPTION 'Reserve cancellation must be restricted to the current Oman calendar day';
  END IF;
  IF position('timetable_weekly_versions' in v_cancel)=0 OR position('status' in v_cancel)=0 THEN
    RAISE EXCEPTION 'Reserve cancellation must verify the active timetable version and assignment state';
  END IF;
  IF position('20 hours' in lower(v_replace))>0 OR position('20 hours' in lower(v_reassign))>0 THEN
    RAISE EXCEPTION 'Legacy 20-hour edit window must be removed';
  END IF;
  IF position('timetable_substitution_assignment_editable_until_day_end' in v_replace)=0 OR position('timetable_substitution_assignment_editable_until_day_end' in v_reassign)=0 OR position('Asia/Muscat' in v_day_window)=0 THEN
    RAISE EXCEPTION 'Single-record reserve edits must enforce the Oman same-day boundary';
  END IF;
  IF position('period' in lower(v_replace))=0 OR position('period' in lower(v_reassign))=0
    OR position('period' in lower(v_batch))=0 THEN
    RAISE EXCEPTION 'Single and batch reserve edits must accept a corrected lesson period';
  END IF;
  IF position('create_timetable_substitution_with_reason' in v_replace)=0
    OR position('create_timetable_substitution_with_reason' in v_reassign)=0 THEN
    RAISE EXCEPTION 'Corrected records must be recreated from the authoritative timetable cell';
  END IF;
  IF NOT has_function_privilege('service_role','public.cancel_timetable_substitution(jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.replace_timetable_substitution_with_reason(jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.reassign_timetable_substitution_absent_with_reason(jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.replace_timetable_substitution_batch_with_reason(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'service_role is missing a reserve correction RPC grant';
  END IF;
  IF has_function_privilege('authenticated','public.cancel_timetable_substitution(jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.cancel_timetable_substitution(jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.replace_timetable_substitution_with_reason(jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.replace_timetable_substitution_with_reason(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'Reserve correction RPCs must not be directly executable by client roles';
  END IF;
END;
$$;
