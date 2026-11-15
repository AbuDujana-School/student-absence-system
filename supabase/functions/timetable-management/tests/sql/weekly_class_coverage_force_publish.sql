BEGIN;
DO $$
DECLARE
  v_version_id uuid;
  v_result jsonb;
  v_weekday text;
  v_saved_days integer;
  v_cell_count integer;
  v_replaced_count integer;
BEGIN
  v_result := public.save_timetable_weekly_day(jsonb_build_object(
    'version_id',null,'weekday','الأحد','teachers','[]'::jsonb,'period_count',7,'actor_name','coverage-test'
  ));
  v_version_id := (v_result->>'version_id')::uuid;
  IF (v_result->>'teacher_count')::integer <> 0 OR (v_result->>'cell_count')::integer <> 0 THEN
    RAISE EXCEPTION 'Empty day should be recorded without invented teacher cells.';
  END IF;

  -- Re-saving an empty day must be tracked as a replacement, not lost because
  -- there are no cell rows for that day.
  PERFORM public.save_timetable_weekly_day(jsonb_build_object(
    'version_id',v_version_id,'weekday','الأحد','teachers','[]'::jsonb,'period_count',7,'actor_name','coverage-test'
  ));

  FOREACH v_weekday IN ARRAY ARRAY['الاثنين','الثلاثاء','الأربعاء','الخميس'] LOOP
    PERFORM public.save_timetable_weekly_day(jsonb_build_object(
      'version_id',v_version_id,'weekday',v_weekday,'teachers','[]'::jsonb,'period_count',7,'actor_name','coverage-test'
    ));
  END LOOP;

  SELECT count(DISTINCT weekday) INTO v_saved_days
  FROM public.timetable_weekly_audit
  WHERE version_id=v_version_id AND action IN ('day_saved','day_replaced');
  SELECT count(*) INTO v_replaced_count
  FROM public.timetable_weekly_audit
  WHERE version_id=v_version_id AND weekday='الأحد' AND action='day_replaced';
  IF v_saved_days <> 5 OR v_replaced_count <> 1 THEN
    RAISE EXCEPTION 'Saved day audit is incomplete: days %, replacements %.',v_saved_days,v_replaced_count;
  END IF;

  v_result := public.activate_timetable_weekly_version(jsonb_build_object(
    'version_id',v_version_id,'actor_name','coverage-test','force_with_warnings',true,
    'warnings',jsonb_build_object('missing_class_slots',980,'test',true)
  ));
  IF v_result->>'status' <> 'active' OR v_result->>'force_with_warnings' <> 'true' THEN
    RAISE EXCEPTION 'Force publication did not preserve warning mode: %',v_result;
  END IF;
  SELECT count(*) INTO v_cell_count FROM public.timetable_weekly_cells WHERE version_id=v_version_id;
  IF v_cell_count <> 0 THEN RAISE EXCEPTION 'Empty source days must not create fabricated cells.'; END IF;
END $$;
ROLLBACK;
