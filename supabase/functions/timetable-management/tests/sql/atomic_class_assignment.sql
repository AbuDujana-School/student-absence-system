begin;

-- The isolated CI database does not include the application's teacher directory.
create table if not exists public.teachers (
  name text primary key,
  role text not null
);
insert into public.teachers(name,role) values ('معلم اختبار الإسناد','teacher')
on conflict (name) do update set role=excluded.role;

insert into public.timetable_weekly_versions(
  version,status,expected_teacher_count,period_count,created_by
) values (998,'active',1,7,'atomic-assignment-test');

insert into public.timetable_weekly_cells(
  version_id,teacher_source_name,matched_teacher_name,match_status,
  weekday,period,cell_status,class_sections,subject,source_data
)
select id,'معلم اختبار الإسناد','معلم اختبار الإسناد','matched',
  'الأحد',1,'teaching','["11 أول"]'::jsonb,'الرياضيات','{}'::jsonb
from public.timetable_weekly_versions where version=998;

insert into public.timetable_weekly_cells(
  version_id,teacher_source_name,matched_teacher_name,match_status,
  weekday,period,cell_status,class_sections,subject,source_data
)
select id,'معلم اختبار الإسناد','معلم اختبار الإسناد','matched',
  'الأحد',2,'free','[]'::jsonb,'','{}'::jsonb
from public.timetable_weekly_versions where version=998;

select public.assign_timetable_class_vacancy(jsonb_build_object(
  'class_name','11 أول','weekday','الأحد','period',2,
  'teacher_name','معلم اختبار الإسناد','subject','العلوم',
  'actor_name','مدير الاختبار'
));

do $$
declare
  v_draft uuid;
  v_status text;
  v_subject text;
  v_draft_count integer;
  v_audit_count integer;
begin
  select id into v_draft from public.timetable_weekly_versions
    where status='draft' and source_label='مراجعة يدوية للنسخة 998';
  if v_draft is null then raise exception 'Atomic assignment did not create a review draft'; end if;

  select cell_status,subject into v_status,v_subject
    from public.timetable_weekly_cells
    where version_id=v_draft and weekday='الأحد' and period=2
      and matched_teacher_name='معلم اختبار الإسناد';
  if v_status is distinct from 'teaching' or v_subject is distinct from 'العلوم' then
    raise exception 'Atomic assignment did not update the teacher source cell';
  end if;

  select count(*) into v_audit_count from public.timetable_weekly_audit
    where version_id=v_draft and action='day_replaced'
      and after_data->>'action'='class_vacancy_assigned';
  if v_audit_count <> 1 then raise exception 'Atomic assignment audit entry is missing'; end if;

  begin
    perform public.assign_timetable_class_vacancy(jsonb_build_object(
      'class_name','11 أول','weekday','الأحد','period',3,
      'teacher_name','معلم اختبار الإسناد','subject','العلوم',
      'actor_name','مدير الاختبار','version_id',v_draft
    ));
    raise exception 'Expected invalid assignment to fail';
  exception when others then
    if sqlerrm='Expected invalid assignment to fail' then raise; end if;
  end;

  select count(*) into v_draft_count from public.timetable_weekly_versions
    where status='draft' and source_label='مراجعة يدوية للنسخة 998';
  if v_draft_count <> 1 then raise exception 'Failed assignment left a partial draft'; end if;
end;
$$;

rollback;
