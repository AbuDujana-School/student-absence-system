-- Isolated integration coverage for cumulative substitution effort points.
-- Runs only after the new cumulative-effort migration and rolls back all fixtures.
begin;

do $test$
declare
  v_version_id uuid;
  v_version_number integer;
  v_two_id uuid;
  v_four_id uuid;
  v_emergency_one_id uuid;
  v_emergency_two_id uuid;
  v_net numeric(10,2);
  v_scale integer;
begin
  select coalesce(max(version),0)+2000 into v_version_number
  from public.timetable_weekly_versions;

  insert into public.timetable_weekly_versions(
    version,status,expected_teacher_count,period_count,created_by
  ) values (
    v_version_number,'draft',4,7,'cumulative-effort-test'
  ) returning id into v_version_id;

  insert into public.timetable_weekly_cells(
    version_id,teacher_source_name,matched_teacher_name,match_status,
    weekday,period,cell_status,class_sections,subject
  )
  select v_version_id,teacher_name,teacher_name,'matched','الأحد',period,'teaching',
         '["10/1"]'::jsonb,'العلوم'
  from (values
    ('__cum_two__',1),('__cum_two__',2),
    ('__cum_four__',1),('__cum_four__',2),('__cum_four__',3),('__cum_four__',4)
  ) as cells(teacher_name,period);

  if public.timetable_substitution_period_weight(1)<>1.00
    or public.timetable_substitution_period_weight(2)<>1.00
    or public.timetable_substitution_period_weight(3)<>1.50
    or public.timetable_substitution_period_weight(4)<>1.50
    or public.timetable_substitution_period_weight(5)<>3.00
    or public.timetable_substitution_period_weight(6)<>2.50
    or public.timetable_substitution_period_weight(7)<>4.00
    or public.timetable_substitution_period_weight(8)<>5.00
    or public.timetable_substitution_period_weight(9)<>0.00 then
    raise exception 'Cumulative effort period weights are incorrect.';
  end if;

  select numeric_scale into v_scale
  from information_schema.columns
  where table_schema='public'
    and table_name='timetable_substitution_points_ledger'
    and column_name='points_delta';
  if v_scale<>2 then
    raise exception 'Points ledger must retain two decimal places; got scale %',v_scale;
  end if;

  -- The pre-migration seed deliberately stored 0.75. Four teaching periods
  -- and period six must be recalculated to 2.50 x 1.60 = 4.00.
  select count(*) into v_scale
  from public.timetable_substitution_points_ledger
  where teacher_name='__cum_backfill__'
    and assignment_date=date '2026-11-29'
    and event_key like 'assignment:%:coverage'
    and points_delta=4.00;
  if v_scale<>1 then
    raise exception 'Historical coverage points were not recalculated from the saved timetable; matching rows: %',v_scale;
  end if;

  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,
    absent_teacher_name,absence_reason,status,created_by
  ) values (
    v_version_id,'__cum_two__','substitution','الأحد',6,date '2026-11-29',
    '__cum_absent_two__','مرضية','assigned','cumulative-effort-test'
  ) returning id into v_two_id;

  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where assignment_id=v_two_id and teacher_name='__cum_two__'
    and event_key='assignment:'||v_two_id::text||':coverage';
  if v_net<>2.50 then
    raise exception 'Two-period daily load must earn 2.50 effort points; got %',v_net;
  end if;

  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,
    absent_teacher_name,absence_reason,status,created_by
  ) values (
    v_version_id,'__cum_four__','substitution','الأحد',6,date '2026-11-29',
    '__cum_absent_four__','موعد مستشفى','assigned','cumulative-effort-test'
  ) returning id into v_four_id;

  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where assignment_id=v_four_id and teacher_name='__cum_four__'
    and event_key='assignment:'||v_four_id::text||':coverage';
  if v_net<>4.00 then
    raise exception 'Four-period daily load must earn 4.00 effort points (2.50 x 1.60); got %',v_net;
  end if;

  -- Emergency compensation is awarded once per absent teacher and date,
  -- regardless of how many covered lessons belong to that absence.
  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,
    absent_teacher_name,absence_reason,status,created_by
  ) values (
    v_version_id,'__cum_emergency_cover_1__','substitution','الأحد',1,date '2026-11-29',
    '__cum_emergency_absent__','طارئة','assigned','cumulative-effort-test'
  ) returning id into v_emergency_one_id;

  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,
    absent_teacher_name,absence_reason,status,created_by
  ) values (
    v_version_id,'__cum_emergency_cover_2__','substitution','الأحد',2,date '2026-11-29',
    '__cum_emergency_absent__','طارئة','assigned','cumulative-effort-test'
  ) returning id into v_emergency_two_id;

  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where teacher_name='__cum_emergency_absent__'
    and event_key like 'absence-emergency:__cum_emergency_absent__:2026-11-29:%';
  if v_net<>2.00 then
    raise exception 'Emergency absence must award exactly two compensation points once per day; got %',v_net;
  end if;

  -- Reversing one lesson must retain the bonus while another lesson remains.
  perform set_config('app.force_substitution_points_reversal','true',true);
  update public.timetable_assignments set status='cancelled' where id=v_emergency_one_id;
  perform set_config('app.force_substitution_points_reversal','false',true);

  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where teacher_name='__cum_emergency_absent__'
    and event_key like 'absence-emergency:__cum_emergency_absent__:2026-11-29:%';
  if v_net<>2.00 then
    raise exception 'Emergency compensation must remain while another covered lesson exists; got %',v_net;
  end if;

  -- Once the final covered lesson is reversed, the emergency bonus is reversed too.
  perform set_config('app.force_substitution_points_reversal','true',true);
  update public.timetable_assignments set status='cancelled' where id=v_emergency_two_id;
  perform set_config('app.force_substitution_points_reversal','false',true);

  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where teacher_name='__cum_emergency_absent__'
    and event_key like 'absence-emergency:__cum_emergency_absent__:2026-11-29:%';
  if v_net<>0.00 then
    raise exception 'Emergency compensation must reverse when all covered lessons are cancelled; got %',v_net;
  end if;
end;
$test$;

rollback;
