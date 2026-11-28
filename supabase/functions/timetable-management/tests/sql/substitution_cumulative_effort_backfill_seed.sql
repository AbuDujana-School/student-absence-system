-- Seed one deliberately stale legacy coverage credit before the cumulative migration.
-- The following migration must recalculate it from the saved timetable, not trust the old value.
begin;

do $seed$
declare
  v_version_id uuid;
  v_version_number integer;
  v_assignment_id uuid;
begin
  select coalesce(max(version),0)+3000 into v_version_number
  from public.timetable_weekly_versions;

  insert into public.timetable_weekly_versions(
    version,status,expected_teacher_count,period_count,created_by
  ) values (
    v_version_number,'draft',1,7,'cumulative-backfill-seed'
  ) returning id into v_version_id;

  insert into public.timetable_weekly_cells(
    version_id,teacher_source_name,matched_teacher_name,match_status,
    weekday,period,cell_status,class_sections,subject
  )
  select v_version_id,'__cum_backfill__','__cum_backfill__','matched',
         'الأحد',period,'teaching','["10/1"]'::jsonb,'العلوم'
  from generate_series(1,4) as period;

  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,
    absent_teacher_name,absence_reason,status,created_by
  ) values (
    v_version_id,'__cum_backfill__','substitution','الأحد',6,date '2026-11-29',
    '__cum_backfill_absent__','مرضية','assigned','cumulative-backfill-seed'
  ) returning id into v_assignment_id;

  update public.timetable_substitution_points_ledger
  set points_delta=1
  where assignment_id=v_assignment_id
    and event_key='assignment:'||v_assignment_id::text||':coverage';

  if not exists(
    select 1 from public.timetable_substitution_points_ledger
    where assignment_id=v_assignment_id
      and event_key='assignment:'||v_assignment_id::text||':coverage'
      and points_delta=1
  ) then
    raise exception 'Could not prepare the stale legacy coverage credit for backfill verification.';
  end if;
end;
$seed$;

commit;
