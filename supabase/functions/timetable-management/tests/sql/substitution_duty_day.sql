-- Regression check: no database trigger may block reserve assignments based on duty day.
do $$
begin
  if exists (
    select 1
      from pg_trigger
     where tgrelid = 'public.timetable_assignments'::regclass
       and tgname = 'timetable_substitution_duty_day_guard'
       and not tgisinternal
  ) then
    raise exception 'Obsolete duty-day substitution trigger is still installed.';
  end if;

  if to_regprocedure('public.guard_timetable_substitution_duty_day()') is not null then
    raise exception 'Obsolete duty-day guard function still exists.';
  end if;
end;
$$;
