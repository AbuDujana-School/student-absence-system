BEGIN;
CREATE TABLE IF NOT EXISTS public.teachers(name text, role text);
DO $coverage$
DECLARE
  v_version_id uuid;
  v_result jsonb;
  v_weekday text;
  v_saved_days integer;
  v_cell_count integer;
  v_replaced_count integer;
  v_previous_cell_count integer;
  v_clone_id uuid;
  v_clone_result jsonb;
BEGIN
  v_result := public.save_timetable_weekly_day(jsonb_build_object(
    'version_id',null,'weekday','الأحد',
    'teachers',jsonb_build_array(jsonb_build_object(
      'sourceName','coverage-test-teacher','matchStatus','unmatched',
      'cells',jsonb_build_array(
        jsonb_build_object('period',1,'status','free','classSections','[]'::jsonb,'subject','','sourceClass','','sourceSubject','','sourceStatus','فراغ'),
        jsonb_build_object('period',2,'status','free','classSections','[]'::jsonb,'subject','','sourceClass','','sourceSubject','','sourceStatus','فراغ'),
        jsonb_build_object('period',3,'status','free','classSections','[]'::jsonb,'subject','','sourceClass','','sourceSubject','','sourceStatus','فراغ'),
        jsonb_build_object('period',4,'status','free','classSections','[]'::jsonb,'subject','','sourceClass','','sourceSubject','','sourceStatus','فراغ'),
        jsonb_build_object('period',5,'status','free','classSections','[]'::jsonb,'subject','','sourceClass','','sourceSubject','','sourceStatus','فراغ'),
        jsonb_build_object('period',6,'status','free','classSections','[]'::jsonb,'subject','','sourceClass','','sourceSubject','','sourceStatus','فراغ'),
        jsonb_build_object('period',7,'status','free','classSections','[]'::jsonb,'subject','','sourceClass','','sourceSubject','','sourceStatus','فراغ')
      )
    )),
    'period_count',7,'actor_name','coverage-test'
  ));
  v_version_id := (v_result->>'version_id')::uuid;
  IF (v_result->>'teacher_count')::integer <> 1 OR (v_result->>'cell_count')::integer <> 7 THEN
    RAISE EXCEPTION 'Initial populated day should store all seven cells.';
  END IF;

  -- Replacing a populated day with an empty source day must keep an accurate
  -- prior-cell count while recording the day as saved.
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
  SELECT (before_data->>'previous_cell_count')::integer INTO v_previous_cell_count
  FROM public.timetable_weekly_audit
  WHERE version_id=v_version_id AND weekday='الأحد' AND action='day_replaced';
  IF v_saved_days <> 5 OR v_replaced_count <> 1 OR v_previous_cell_count <> 7 THEN
    RAISE EXCEPTION 'Saved day audit is incomplete: days %, replacements %, previous cells %.',v_saved_days,v_replaced_count,v_previous_cell_count;
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

  -- A manually corrected clone can prove a full week through its copied cells
  -- even when it does not carry the original five day-save audit entries.
  INSERT INTO public.timetable_weekly_versions(version,status,expected_teacher_count,period_count,created_by)
  VALUES ((SELECT coalesce(max(version),0)+1 FROM public.timetable_weekly_versions),'draft',1,7,'coverage-clone-test')
  RETURNING id INTO v_clone_id;
  INSERT INTO public.timetable_weekly_cells(version_id,teacher_source_name,match_status,weekday,period,cell_status)
  SELECT v_clone_id,'clone-test-teacher','unmatched',day_name,period_number,'free'
  FROM unnest(ARRAY['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس']) AS weekdays(day_name)
  CROSS JOIN generate_series(1,7) AS periods(period_number);
  v_clone_result := public.activate_timetable_weekly_version(jsonb_build_object(
    'version_id',v_clone_id,'actor_name','coverage-clone-test','force_with_warnings',true,
    'warnings',jsonb_build_object('test_clone',true)
  ));
  IF v_clone_result->>'status' <> 'active' THEN
    RAISE EXCEPTION 'A complete five-day clone must be eligible for warning-enabled activation: %',v_clone_result;
  END IF;
END $coverage$;
ROLLBACK;
