-- Enforce duty-day exclusion at the database boundary as well as in preview ranking.
-- Additive guard only: existing timetable, teacher, student and permission rows are untouched.

create or replace function public.guard_timetable_substitution_duty_day()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_permissions jsonb;
  v_duty_settings jsonb;
  v_department text;
  v_personal_duty_day text;
  v_department_duty_day text;
  v_effective_duty_day text;
begin
  if new.assignment_type is distinct from 'substitution'
    or new.status not in ('assigned', 'confirmed', 'completed') then
    return new;
  end if;

  select permissions
    into v_permissions
    from public.teachers
   where name = new.teacher_name
     and role = 'teacher';

  if not found then
    raise exception 'المعلم البديل غير موجود في دليل المعلمين.';
  end if;

  v_department := coalesce(
    nullif(btrim(v_permissions->>'category'), ''),
    nullif(btrim(v_permissions->>'department_id'), ''),
    nullif(btrim(v_permissions->>'department_name'), ''),
    ''
  );
  v_personal_duty_day := nullif(btrim(v_permissions->>'dutyDay'), '');

  select value
    into v_duty_settings
    from public.school_settings
   where key = 'duty_module';

  v_department_duty_day := case
    when v_department <> '' then nullif(btrim(v_duty_settings->'subjectDays'->>v_department), '')
    else null
  end;

  -- Match the application rule: a personal duty day overrides the category duty day.
  v_effective_duty_day := coalesce(v_personal_duty_day, v_department_duty_day);

  if v_effective_duty_day = new.weekday then
    raise exception 'المعلم البديل مكلف بالمناوبة في هذا اليوم، ولا يمكن إسناد احتياط له.';
  end if;

  return new;
end;
$function$;

drop trigger if exists timetable_substitution_duty_day_guard
  on public.timetable_assignments;

create trigger timetable_substitution_duty_day_guard
before insert or update
on public.timetable_assignments
for each row
execute function public.guard_timetable_substitution_duty_day();

revoke all on function public.guard_timetable_substitution_duty_day() from public, anon, authenticated;
grant execute on function public.guard_timetable_substitution_duty_day() to service_role;
