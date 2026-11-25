DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Muscat')::date;
  v_create text := pg_get_functiondef('public.create_timetable_substitution(jsonb)'::regprocedure);
  v_replace text := pg_get_functiondef('public.replace_timetable_substitution_with_reason(jsonb)'::regprocedure);
  v_reassign text := pg_get_functiondef('public.reassign_timetable_substitution_absent_with_reason(jsonb)'::regprocedure);
BEGIN
  IF NOT public.timetable_substitution_assignment_editable_until_day_end(v_today) THEN
    RAISE EXCEPTION 'A saved reserve assignment must remain editable throughout its assigned Muscat day.';
  END IF;
  IF NOT public.timetable_substitution_assignment_editable_until_day_end(v_today + 1) THEN
    RAISE EXCEPTION 'A future reserve assignment must be editable before its assigned day.';
  END IF;
  IF position('timetable_substitution_period_is_open(v_date,v_period)' in v_create)=0
    OR position('app.allow_saved_substitution_replacement' in v_create)=0 THEN
    RAISE EXCEPTION 'New assignments must retain the lesson-end cutoff unless called by a saved-assignment correction.';
  END IF;
  IF position('app.allow_saved_substitution_replacement' in v_replace)=0
    OR position('app.allow_saved_substitution_replacement' in v_reassign)=0 THEN
    RAISE EXCEPTION 'Saved assignment corrections must explicitly use the protected replacement path.';
  END IF;
  IF public.timetable_substitution_assignment_editable_until_day_end(v_today - 1) THEN
    RAISE EXCEPTION 'A past reserve assignment must be read-only.';
  END IF;
END;
$$;
