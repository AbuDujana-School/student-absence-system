begin;
do $test$
declare
  v_version uuid;
  v_result jsonb;
  v_count integer;
  v_audit_count integer;
begin
  insert into public.timetable_weekly_versions(version,status,created_by,period_count)
  values (9801,'draft','admin-reset-test',8)
  returning id into v_version;

  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,subject,status,created_by
  ) values
    (v_version,'Substitute EN 1','substitution','الأحد',1,date '2026-11-15','اللغة الإنجليزية','assigned','admin-reset-test'),
    (v_version,'Substitute EN 2','substitution','الأحد',2,date '2026-11-15','اللغة الإنجليزية','confirmed','admin-reset-test'),
    (v_version,'Substitute SCI','substitution','الأحد',3,date '2026-11-15','العلوم','assigned','admin-reset-test'),
    (v_version,'Substitute EN Other Day','substitution','الاثنين',1,date '2026-11-16','اللغة الإنجليزية','assigned','admin-reset-test'),
    (v_version,'Substitute Completed','substitution','الأحد',4,date '2026-11-15','اللغة الإنجليزية','completed','admin-reset-test');

  begin
    perform public.reset_timetable_substitution_records(jsonb_build_object(
      'actor_name','Not Admin','actor_type','teacher','mode','all_active'
    ));
    raise exception 'A non-admin reset unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'A non-admin reset unexpectedly succeeded' then raise; end if;
  end;

  v_result := public.reset_timetable_substitution_records(jsonb_build_object(
    'actor_name','مدير النظام العام','actor_type','admin','mode','subject_day',
    'assignment_date','2026-11-15','subject','اللغة الإنجليزية'
  ));
  if (v_result->>'cancelled_count')::integer <> 2 then
    raise exception 'Expected exactly two English assignments to be cancelled; got %', v_result->>'cancelled_count';
  end if;

  select count(*) into v_count from public.timetable_assignments
   where version_id=v_version and assignment_type='substitution'
     and assignment_date=date '2026-11-15' and subject='اللغة الإنجليزية'
     and status='cancelled';
  if v_count <> 2 then raise exception 'Subject/day reset did not cancel both matching assignments'; end if;

  select count(*) into v_count from public.timetable_assignments
   where version_id=v_version and assignment_type='substitution'
     and assignment_date=date '2026-11-15' and subject='العلوم'
     and status='assigned';
  if v_count <> 1 then raise exception 'Subject/day reset changed another subject'; end if;

  select count(*) into v_count from public.timetable_assignments
   where version_id=v_version and assignment_type='substitution'
     and assignment_date=date '2026-11-16' and status='assigned';
  if v_count <> 1 then raise exception 'Subject/day reset changed another date'; end if;

  select count(*) into v_count from public.timetable_assignments
   where version_id=v_version and status='completed';
  if v_count <> 1 then raise exception 'Reset must preserve completed historical assignments'; end if;

  select count(*) into v_audit_count from public.timetable_assignment_audit
   where version_id=v_version and action='admin_reset_subject_day';
  if v_audit_count <> 2 then raise exception 'Expected two audit rows for subject/day reset'; end if;

  v_result := public.reset_timetable_substitution_records(jsonb_build_object(
    'actor_name','مدير النظام العام','actor_type','admin','mode','all_active'
  ));
  if (v_result->>'cancelled_count')::integer <> 2 then
    raise exception 'Expected remaining two active assignments to be cancelled; got %', v_result->>'cancelled_count';
  end if;

  select count(*) into v_count from public.timetable_assignments
   where version_id=v_version and status in ('assigned','confirmed');
  if v_count <> 0 then raise exception 'Full reset left active assignments'; end if;

  select count(*) into v_audit_count from public.timetable_assignment_audit
   where version_id=v_version and action='admin_reset_all';
  if v_audit_count <> 2 then raise exception 'Expected two audit rows for full reset'; end if;
end;
$test$;
rollback;
