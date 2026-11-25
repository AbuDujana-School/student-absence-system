begin;

do $test$
declare
  v_version_id uuid;
  v_reserve_one uuid;
  v_reserve_two uuid;
  v_duty_id uuid;
  v_other_id uuid;
  v_result jsonb;
  v_count bigint;
  v_rejected boolean := false;
begin
  insert into public.timetable_weekly_versions(version, status, created_by, period_count)
  values (9901, 'draft', 'admin-reserve-clear-test', 7)
  returning id into v_version_id;

  insert into public.timetable_assignments(
    version_id, teacher_name, absent_teacher_name, assignment_type,
    weekday, period, assignment_date, class_sections, subject, status, created_by
  ) values (
    v_version_id, 'Substitute reset one', 'Absent reset one', 'substitution',
    'الأحد', 1, date '2026-11-22', '["10/1"]'::jsonb, 'اللغة الإنجليزية', 'assigned', 'reset-test'
  ) returning id into v_reserve_one;

  insert into public.timetable_assignments(
    version_id, teacher_name, absent_teacher_name, assignment_type,
    weekday, period, assignment_date, class_sections, subject, status, created_by
  ) values (
    v_version_id, 'Substitute reset two', 'Absent reset two', 'substitution',
    'الاثنين', 2, date '2026-11-23', '["10/2"]'::jsonb, 'الرياضيات', 'completed', 'reset-test'
  ) returning id into v_reserve_two;

  insert into public.timetable_assignments(
    version_id, teacher_name, assignment_type,
    weekday, period, assignment_date, class_sections, subject, status, created_by
  ) values (
    v_version_id, 'Duty keeper', 'duty',
    'الأحد', 3, date '2026-11-22', '["10/3"]'::jsonb, 'المناوبة', 'assigned', 'reset-test'
  ) returning id into v_duty_id;

  insert into public.timetable_assignments(
    version_id, teacher_name, assignment_type,
    weekday, period, assignment_date, class_sections, subject, status, created_by
  ) values (
    v_version_id, 'Other task owner', 'other',
    'الأحد', 4, date '2026-11-22', '["10/4"]'::jsonb, 'مهمة أخرى', 'assigned', 'reset-test'
  ) returning id into v_other_id;

  insert into public.timetable_assignment_audit(
    assignment_id, version_id, action, actor_name, after_data
  ) values
    (v_reserve_one, v_version_id, 'created', 'reset-test', '{"type":"substitution"}'::jsonb),
    (v_reserve_two, v_version_id, 'created', 'reset-test', '{"type":"substitution"}'::jsonb),
    (v_duty_id, v_version_id, 'created', 'reset-test', '{"type":"duty"}'::jsonb),
    (v_other_id, v_version_id, 'created', 'reset-test', '{"type":"other"}'::jsonb);

  -- Weighted-points triggers may already have inserted these event keys.
  insert into public.timetable_substitution_points_ledger(
    assignment_id, teacher_name, event_key, event_type, points_delta,
    period, weekday, assignment_date, absent_teacher_name
  ) values
    (v_reserve_one, 'Substitute reset one', 'assignment:' || v_reserve_one::text || ':coverage', 'coverage_credit', 1, 1, 'الأحد', date '2026-11-22', 'Absent reset one'),
    (v_reserve_one, 'Absent reset one', 'assignment:' || v_reserve_one::text || ':absence', 'absence_debit', -1, 1, 'الأحد', date '2026-11-22', 'Absent reset one'),
    (v_reserve_two, 'Substitute reset two', 'assignment:' || v_reserve_two::text || ':coverage', 'coverage_credit', 1, 2, 'الاثنين', date '2026-11-23', 'Absent reset two'),
    (v_reserve_two, 'Absent reset two', 'assignment:' || v_reserve_two::text || ':absence', 'absence_debit', -1, 2, 'الاثنين', date '2026-11-23', 'Absent reset two')
  on conflict (event_key) do nothing;

  begin
    perform public.admin_delete_all_timetable_substitution_records('حساب غير مخول');
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'The reserve-clear RPC accepted a non-general administrator.';
  end if;

  v_result := public.admin_delete_all_timetable_substitution_records('مدير النظام العام');
  if v_result->>'ok' <> 'true' then
    raise exception 'The reserve-clear RPC did not return success.';
  end if;
  if (v_result->>'deleted_assignments')::bigint <> 2 then
    raise exception 'Expected exactly two substitution assignments to be deleted.';
  end if;
  if (v_result->>'deleted_audit_rows')::bigint <> 2 then
    raise exception 'Expected exactly two substitution audit rows to be deleted.';
  end if;
  if (v_result->>'deleted_points_rows')::bigint <> 4 then
    raise exception 'Expected exactly four substitution point-ledger rows to be deleted.';
  end if;

  select count(*) into v_count from public.timetable_assignments
   where id in (v_reserve_one, v_reserve_two);
  if v_count <> 0 then raise exception 'Substitution assignments remain after reset.'; end if;

  select count(*) into v_count from public.timetable_assignment_audit
   where assignment_id in (v_reserve_one, v_reserve_two);
  if v_count <> 0 then raise exception 'Substitution audit history remains after reset.'; end if;

  select count(*) into v_count from public.timetable_substitution_points_ledger
   where assignment_id in (v_reserve_one, v_reserve_two);
  if v_count <> 0 then raise exception 'Substitution points remain after reset.'; end if;

  select count(*) into v_count from public.timetable_assignments
   where id in (v_duty_id, v_other_id);
  if v_count <> 2 then raise exception 'Duty/other assignments were changed by reserve reset.'; end if;

  select count(*) into v_count from public.timetable_assignment_audit
   where assignment_id in (v_duty_id, v_other_id);
  if v_count <> 2 then raise exception 'Duty/other audit rows were changed by reserve reset.'; end if;

  select count(*) into v_count from public.timetable_weekly_versions
   where id = v_version_id and status = 'draft';
  if v_count <> 1 then raise exception 'Weekly timetable version was changed by reserve reset.'; end if;
end;
$test$;

rollback;
