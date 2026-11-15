DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='timetable_assignments'
      AND column_name='reserve_reason' AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'timetable_assignments.reserve_reason must exist and be NOT NULL';
  END IF;
  IF to_regprocedure('public.create_timetable_substitution_with_reason(jsonb)') IS NULL
    OR to_regprocedure('public.create_timetable_substitution_batch_with_reason(jsonb)') IS NULL
    OR to_regprocedure('public.replace_timetable_substitution_with_reason(jsonb)') IS NULL
    OR to_regprocedure('public.replace_timetable_substitution_batch_with_reason(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'One or more reserve-reason RPC functions are missing';
  END IF;
  IF NOT has_function_privilege('service_role','public.create_timetable_substitution_with_reason(jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.replace_timetable_substitution_batch_with_reason(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'service_role is missing reserve-reason RPC execution grants';
  END IF;
  IF has_function_privilege('authenticated','public.create_timetable_substitution_with_reason(jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.create_timetable_substitution_with_reason(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'Reserve-reason RPCs must not be directly executable by client roles';
  END IF;
  IF to_regclass('public.timetable_substitution_points_ledger_assignment_id_idx') IS NULL THEN
    RAISE EXCEPTION 'Substitution ledger assignment index is missing';
  END IF;
END;
$$;
