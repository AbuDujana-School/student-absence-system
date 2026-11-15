begin;
do $test$
declare
  v_version_id uuid;
  v_assignment_id uuid;
  v_cover_balance integer;
  v_absent_balance integer;
  v_event_count integer;
begin
  if public.timetable_substitution_period_points(1)<>1
    or public.timetable_substitution_period_points(2)<>1
    or public.timetable_substitution_period_points(3)<>2
    or public.timetable_substitution_period_points(4)<>2
    or public.timetable_substitution_period_points(5)<>4
    or public.timetable_substitution_period_points(6)<>3
    or public.timetable_substitution_period_points(7)<>5
    or public.timetable_substitution_period_points(8)<>7
    or public.timetable_substitution_period_points(9)<>0 then
    raise exception 'Substitution period point weights are incorrect.';
  end if;
  if not exists(select 1 from pg_proc where proname='create_timetable_substitution_batch') then
    raise exception 'Atomic batch substitution RPC is missing.';
  end if;
  if not exists(select 1 from pg_trigger where tgname='timetable_substitution_points_ledger_trigger' and not tgisinternal) then
    raise exception 'Substitution points ledger trigger is missing.';
  end if;
  if position('not between 1 and 8' in pg_get_functiondef('public.create_timetable_substitution(jsonb)'::regprocedure))=0 then
    raise exception 'Single substitution RPC does not accept the eighth period.';
  end if;

  insert into public.timetable_weekly_versions(version,status,created_by,period_count)
  values((select coalesce(max(version),0)+1000 from public.timetable_weekly_versions),'draft','points-test',8)
  returning id into v_version_id;

  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,
    absent_teacher_name,status,created_by
  ) values (
    v_version_id,'points-test-substitute','substitution','الأحد',5,date '2026-11-15',
    'points-test-absent','assigned','points-test'
  ) returning id into v_assignment_id;

  select sum(points_delta) into v_cover_balance
    from public.timetable_substitution_points_ledger
    where assignment_id=v_assignment_id and teacher_name='points-test-substitute';
  select sum(points_delta) into v_absent_balance
    from public.timetable_substitution_points_ledger
    where assignment_id=v_assignment_id and teacher_name='points-test-absent';
  if v_cover_balance<>4 or v_absent_balance<>-4 then
    raise exception 'Coverage credit and absence debit were not recorded with the correct period weight.';
  end if;

  update public.timetable_assignments set status='cancelled' where id=v_assignment_id;
  select coalesce(sum(points_delta),0) into v_cover_balance
    from public.timetable_substitution_points_ledger
    where assignment_id=v_assignment_id and teacher_name='points-test-substitute';
  select coalesce(sum(points_delta),0) into v_absent_balance
    from public.timetable_substitution_points_ledger
    where assignment_id=v_assignment_id and teacher_name='points-test-absent';
  select count(*) into v_event_count from public.timetable_substitution_points_ledger where assignment_id=v_assignment_id;
  if v_cover_balance<>0 or v_absent_balance<>0 or v_event_count<>4 then
    raise exception 'Cancellation did not reverse both point entries exactly once.';
  end if;
end;
$test$;
rollback;
