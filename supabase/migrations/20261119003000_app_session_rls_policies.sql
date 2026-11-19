-- App-only access policies for the seven core school-data tables.
-- These policies apply to the anon PostgREST role only when a valid opaque
-- x-app-session token is present. Existing authenticated policies remain intact.
create or replace function private.app_session_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from private.current_app_session_principal() as p
    where p.principal_type = 'admin'
       or exists (
         select 1 from public.teachers as t
         where t.name = p.principal_name
           and t.role = p.principal_type
           and coalesce(t.permissions ->> 'admin', 'false') = 'true'
       )
  );
$function$;

create or replace function private.app_session_can_write(p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from private.current_app_session_principal() as p
    where p.principal_type = 'admin'
       or exists (
         select 1
         from public.teachers as t
         where t.name = p.principal_name
           and t.role = p.principal_type
           and case p_capability
             when 'attendance' then
               case
                 when pg_catalog.jsonb_typeof(t.permissions -> 'attendance') = 'boolean'
                   then (t.permissions ->> 'attendance')::boolean
                 else p.principal_type = 'teacher'
               end
             when 'behavior' then
               case
                 when pg_catalog.jsonb_typeof(t.permissions -> 'behavior') = 'boolean'
                   then (t.permissions ->> 'behavior')::boolean
                 else p.principal_type = 'teacher'
               end
             when 'duty' then
               case
                 when pg_catalog.jsonb_typeof(t.permissions -> 'duty') = 'boolean'
                   then (t.permissions ->> 'duty')::boolean
                 else p.principal_type = 'teacher'
               end
             else false
           end
       )
  );
$function$;

revoke all on function private.app_session_is_admin() from public;
revoke all on function private.app_session_can_write(text) from public;
grant execute on function private.app_session_is_admin() to anon, authenticated;
grant execute on function private.app_session_can_write(text) to anon, authenticated;

-- PostgREST needs SQL privileges before RLS policies are evaluated. These
-- grants do not expose rows: every anon operation is constrained below.
grant select, insert, update, delete on
  public.classes, public.students, public.teachers, public.attendance,
  public.behaviors, public.school_settings, public.duty_reports
to anon;

grant usage, select on sequence
  public.students_id_seq, public.teachers_id_seq,
  public.attendance_id_seq, public.behaviors_id_seq
to anon;

-- Read access is available only to a currently authenticated application session.
do $policies$
declare
  table_name text;
begin
  foreach table_name in array array[
    'classes','students','teachers','attendance','behaviors','school_settings','duty_reports'
  ] loop
    execute format('drop policy if exists app_session_read on public.%I', table_name);
    execute format(
      'create policy app_session_read on public.%I for select to anon using (exists (select 1 from private.current_app_session_principal()))',
      table_name
    );
  end loop;
end;
$policies$;

-- Administrative data and credentials remain writable only by the system administrator.
do $admin_policies$
declare
  table_name text;
begin
  foreach table_name in array array['classes','students','teachers','school_settings'] loop
    execute format('drop policy if exists app_session_admin_write on public.%I', table_name);
    execute format(
      'create policy app_session_admin_write on public.%I for all to anon using (private.app_session_is_admin()) with check (private.app_session_is_admin())',
      table_name
    );
  end loop;
end;
$admin_policies$;

-- Teachers may record attendance/behavior only when their current server-side
-- account permissions allow the relevant module. Deletion remains admin-only.
drop policy if exists app_session_attendance_insert on public.attendance;
create policy app_session_attendance_insert on public.attendance
  for insert to anon with check (private.app_session_can_write('attendance'));
drop policy if exists app_session_attendance_update on public.attendance;
create policy app_session_attendance_update on public.attendance
  for update to anon using (private.app_session_can_write('attendance'))
  with check (private.app_session_can_write('attendance'));
drop policy if exists app_session_attendance_delete on public.attendance;
create policy app_session_attendance_delete on public.attendance
  for delete to anon using (private.app_session_is_admin());

drop policy if exists app_session_behavior_insert on public.behaviors;
create policy app_session_behavior_insert on public.behaviors
  for insert to anon with check (private.app_session_can_write('behavior'));
drop policy if exists app_session_behavior_update on public.behaviors;
create policy app_session_behavior_update on public.behaviors
  for update to anon using (private.app_session_can_write('behavior'))
  with check (private.app_session_can_write('behavior'));
drop policy if exists app_session_behavior_delete on public.behaviors;
create policy app_session_behavior_delete on public.behaviors
  for delete to anon using (private.app_session_is_admin());

-- Duty reports may be submitted by teachers whose current account has duty
-- access; only administrators can revise or delete existing reports.
drop policy if exists app_session_duty_insert on public.duty_reports;
create policy app_session_duty_insert on public.duty_reports
  for insert to anon with check (private.app_session_can_write('duty'));
drop policy if exists app_session_duty_update on public.duty_reports;
create policy app_session_duty_update on public.duty_reports
  for update to anon using (private.app_session_is_admin())
  with check (private.app_session_is_admin());
drop policy if exists app_session_duty_delete on public.duty_reports;
create policy app_session_duty_delete on public.duty_reports
  for delete to anon using (private.app_session_is_admin());
