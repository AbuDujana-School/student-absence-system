-- Transactional integration tests for reserve-point lifecycle rules.
begin;

do $test$
declare
  v_version_id uuid;
  v_version_number integer;
  v_emergency_id uuid;
  v_normal_id uuid;
  v_gap_id uuid;
  v_recent_delete_id uuid;
  v_old_delete_id uuid;
  v_move_old_id uuid;
  v_move_new_id uuid;
  v_net integer;
begin
  select coalesce(max(version),0)+1 into v_version_number from public.timetable_weekly_versions;
  insert into public.timetable_weekly_versions(version,status,expected_teacher_count,period_count,created_by)
  values(v_version_number,'draft',5,7,'reserve-points-rules-test')
  returning id into v_version_id;

  insert into public.timetable_weekly_cells(
    version_id,teacher_source_name,matched_teacher_name,match_status,weekday,period,cell_status,class_sections,subject
  ) values
    (v_version_id,'__points_emergency__','__points_emergency__','matched','الأحد',1,'teaching','["10/1"]'::jsonb,'العلوم'),
    (v_version_id,'__points_emergency__','__points_emergency__','matched','الأحد',2,'teaching','["10/1"]'::jsonb,'العلوم'),
    (v_version_id,'__points_normal__','__points_normal__','matched','الأحد',1,'teaching','["10/1"]'::jsonb,'العلوم'),
    (v_version_id,'__points_normal__','__points_normal__','matched','الأحد',2,'teaching','["10/1"]'::jsonb,'العلوم'),
    (v_version_id,'__points_gap__','__points_gap__','matched','الأحد',1,'teaching','["10/1"]'::jsonb,'العلوم'),
    (v_version_id,'__points_gap__','__points_gap__','matched','الأحد',3,'teaching','["10/1"]'::jsonb,'العلوم');

  -- Emergency reason + exactly the two immediately preceding teaching periods => +2.
  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,reserve_reason,status,created_by
  ) values (
    v_version_id,'__points_emergency__','substitution','الأحد',3,date '2026-11-15','-','assigned','reserve-points-rules-test'
  ) returning id into v_emergency_id;
  update public.timetable_assignments set reserve_reason='احتياط اضطراري' where id=v_emergency_id;
  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where assignment_id=v_emergency_id and teacher_name='__points_emergency__';
  if v_net<>4 then raise exception 'Emergency reserve should earn period points plus two bonus points; got %',v_net; end if;

  -- Removing the emergency marker removes only the two-point bonus.
  update public.timetable_assignments set reserve_reason='احتياط عادي' where id=v_emergency_id;
  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where assignment_id=v_emergency_id and teacher_name='__points_emergency__';
  if v_net<>2 then raise exception 'Changing the reason must remove the emergency bonus only; got %',v_net; end if;

  -- Restore emergency, then cancellation inside 14 hours must reverse base and bonus.
  update public.timetable_assignments set reserve_reason='احتياط اضطراري' where id=v_emergency_id;
  update public.timetable_assignments set status='cancelled' where id=v_emergency_id;
  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where assignment_id=v_emergency_id and teacher_name='__points_emergency__';
  if v_net<>0 then raise exception 'Cancellation inside 14 hours must reverse the teacher points; got %',v_net; end if;

  -- A reason saying ordinary reserve must not create the emergency bonus.
  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,reserve_reason,status,created_by
  ) values (
    v_version_id,'__points_normal__','substitution','الأحد',3,date '2026-11-15','احتياط عادي','assigned','reserve-points-rules-test'
  ) returning id into v_normal_id;
  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where assignment_id=v_normal_id and teacher_name='__points_normal__';
  if v_net<>2 then raise exception 'Ordinary reserve must receive only the standard two points; got %',v_net; end if;

  -- An emergency reserve after a gap does not qualify as the third consecutive period.
  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,reserve_reason,status,created_by
  ) values (
    v_version_id,'__points_gap__','substitution','الأحد',4,date '2026-11-15','احتياط اضطراري','assigned','reserve-points-rules-test'
  ) returning id into v_gap_id;
  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where assignment_id=v_gap_id and teacher_name='__points_gap__';
  if v_net<>2 then raise exception 'A gap before the emergency reserve must not earn the bonus; got %',v_net; end if;

  -- Normal deletion within 14 hours removes the reserve points.
  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,reserve_reason,status,created_by,created_at,reserve_created_at
  ) values (
    v_version_id,'__points_recent_delete__','substitution','الأحد',4,date '2026-11-15','-','assigned',
    'reserve-points-rules-test',now()-interval '13 hours',now()-interval '13 hours'
  ) returning id into v_recent_delete_id;
  update public.timetable_assignments set status='cancelled' where id=v_recent_delete_id;
  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where assignment_id=v_recent_delete_id and teacher_name='__points_recent_delete__';
  if v_net<>0 then raise exception 'Deletion inside 14 hours must leave zero reserve points; got %',v_net; end if;

  -- A plain deletion after 14 hours keeps the points already earned.
  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,reserve_reason,status,created_by,created_at,reserve_created_at
  ) values (
    v_version_id,'__points_old_delete__','substitution','الأحد',5,date '2026-11-15','-','assigned',
    'reserve-points-rules-test',now()-interval '15 hours',now()-interval '15 hours'
  ) returning id into v_old_delete_id;
  update public.timetable_assignments set status='cancelled' where id=v_old_delete_id;
  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where assignment_id=v_old_delete_id and teacher_name='__points_old_delete__';
  if v_net<>4 then raise exception 'Deletion after 14 hours must preserve earned reserve points; got %',v_net; end if;

  -- A move/replacement always reverses the old period, even after 14 hours,
  -- then awards the new period's standard score only.
  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,reserve_reason,status,created_by,created_at,reserve_created_at
  ) values (
    v_version_id,'__points_move__','substitution','الأحد',1,date '2026-11-15','-','assigned',
    'reserve-points-rules-test',now()-interval '15 hours',now()-interval '15 hours'
  ) returning id into v_move_old_id;
  perform set_config('app.force_substitution_points_reversal','true',true);
  update public.timetable_assignments set status='cancelled' where id=v_move_old_id;
  perform set_config('app.force_substitution_points_reversal','false',true);
  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,reserve_reason,status,created_by
  ) values (
    v_version_id,'__points_move__','substitution','الأحد',6,date '2026-11-15','-','assigned','reserve-points-rules-test'
  ) returning id into v_move_new_id;
  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where assignment_id=v_move_old_id and teacher_name='__points_move__';
  if v_net<>0 then raise exception 'Moving must remove all points from the old period; got %',v_net; end if;
  select coalesce(sum(points_delta),0) into v_net
  from public.timetable_substitution_points_ledger
  where assignment_id=v_move_new_id and teacher_name='__points_move__';
  if v_net<>3 then raise exception 'Moving must award only the new period points; got %',v_net; end if;
end;
$test$;

rollback;
