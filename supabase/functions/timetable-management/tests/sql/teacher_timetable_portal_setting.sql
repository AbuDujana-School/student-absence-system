do $$
begin
  if not exists (
    select 1 from public.teacher_timetable_portal_settings
    where id = true and enabled = false
  ) then
    raise exception 'Teacher timetable portal must remain disabled by default';
  end if;
  if has_table_privilege('anon', 'public.teacher_timetable_portal_settings', 'SELECT')
    or has_table_privilege('authenticated', 'public.teacher_timetable_portal_settings', 'SELECT') then
    raise exception 'Teacher timetable portal settings must not be readable by client roles';
  end if;
end;
$$;
