-- Verify the individual portal grant store is private and service-role writable.
do $$
begin
  if to_regclass('public.teacher_timetable_portal_grants') is null then
    raise exception 'individual portal grants table is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.teacher_timetable_portal_grants'::regclass) then
    raise exception 'RLS must be enabled on individual portal grants';
  end if;
  if has_table_privilege('anon', 'public.teacher_timetable_portal_grants', 'SELECT')
     or has_table_privilege('authenticated', 'public.teacher_timetable_portal_grants', 'SELECT') then
    raise exception 'public-facing roles must not read individual portal grants';
  end if;
  if not has_table_privilege('service_role', 'public.teacher_timetable_portal_grants', 'SELECT')
     or not has_table_privilege('service_role', 'public.teacher_timetable_portal_grants', 'INSERT')
     or not has_table_privilege('service_role', 'public.teacher_timetable_portal_grants', 'UPDATE') then
    raise exception 'service_role must manage individual portal grants';
  end if;
end $$;

insert into public.teacher_timetable_portal_grants
  (teacher_name, active, granted_by)
values ('Test Teacher Individual Grant', true, 'Test Admin')
on conflict (teacher_name) do update
set active = excluded.active, granted_by = excluded.granted_by;

do $$
begin
  if not exists (
    select 1 from public.teacher_timetable_portal_grants
    where teacher_name = 'Test Teacher Individual Grant' and active = true
  ) then
    raise exception 'individual grant upsert failed';
  end if;
end $$;

update public.teacher_timetable_portal_grants
set active = false, revoked_by = 'Test Teacher', revoked_at = now()
where teacher_name = 'Test Teacher Individual Grant';

do $$
begin
  if not exists (
    select 1 from public.teacher_timetable_portal_grants
    where teacher_name = 'Test Teacher Individual Grant' and active = false
      and revoked_by = 'Test Teacher' and revoked_at is not null
  ) then
    raise exception 'individual grant revocation audit failed';
  end if;
end $$;
