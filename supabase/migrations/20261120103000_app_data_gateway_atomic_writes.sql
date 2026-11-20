create or replace function public.app_data_gateway_write_records(
  p_table text,
  p_rows jsonb,
  p_allow_owner_overwrite boolean default false
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_count integer;
  v_expected integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 500 then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  v_expected := jsonb_array_length(p_rows);

  if p_table = 'attendance' then
    insert into public.attendance (record_key, date_str, class_name, period, teacher_name, records, updated_at)
    select x.record_key, x.date_str, x.class_name, x.period, x.teacher_name, x.records, x.updated_at
    from jsonb_populate_recordset(null::public.attendance, p_rows) as x
    on conflict (record_key) do update set
      date_str = excluded.date_str,
      class_name = excluded.class_name,
      period = excluded.period,
      teacher_name = excluded.teacher_name,
      records = excluded.records,
      updated_at = excluded.updated_at
    where p_allow_owner_overwrite or attendance.teacher_name is not distinct from excluded.teacher_name;

  elsif p_table = 'behaviors' then
    insert into public.behaviors (record_key, date_str, class_name, period, teacher_name, records, updated_at)
    select x.record_key, x.date_str, x.class_name, x.period, x.teacher_name, x.records, x.updated_at
    from jsonb_populate_recordset(null::public.behaviors, p_rows) as x
    on conflict (record_key) do update set
      date_str = excluded.date_str,
      class_name = excluded.class_name,
      period = excluded.period,
      teacher_name = excluded.teacher_name,
      records = excluded.records,
      updated_at = excluded.updated_at
    where p_allow_owner_overwrite or behaviors.teacher_name is not distinct from excluded.teacher_name;

  elsif p_table = 'students' then
    if not p_allow_owner_overwrite then raise exception 'admin only' using errcode = '42501'; end if;
    insert into public.students (class_name, student_name)
    select x.class_name, x.student_name
    from jsonb_populate_recordset(null::public.students, p_rows) as x
    on conflict (class_name, student_name) do update set student_name = excluded.student_name;
    get diagnostics v_count = row_count;
  elsif p_table = 'classes' then
    if not p_allow_owner_overwrite then raise exception 'admin only' using errcode = '42501'; end if;
    insert into public.classes (name)
    select x.name from jsonb_populate_recordset(null::public.classes, p_rows) as x
    on conflict (name) do update set name = excluded.name;
    get diagnostics v_count = row_count;
  elsif p_table = 'teachers' then
    if not p_allow_owner_overwrite then raise exception 'admin only' using errcode = '42501'; end if;
    insert into public.teachers (name, role, permissions, must_change_pin)
    select x.name, x.role, x.permissions, x.must_change_pin
    from jsonb_populate_recordset(null::public.teachers, p_rows) as x
    on conflict (name) do update set
      role = excluded.role,
      permissions = excluded.permissions,
      must_change_pin = excluded.must_change_pin;
    get diagnostics v_count = row_count;
  elsif p_table = 'school_settings' then
    if not p_allow_owner_overwrite then raise exception 'admin only' using errcode = '42501'; end if;
    if exists (select 1 from jsonb_array_elements(p_rows) e where e->>'key' = 'admin_pin') then
      raise exception 'credential setting is not allowed' using errcode = '42501';
    end if;
    insert into public.school_settings (key, value)
    select x.key, x.value
    from jsonb_populate_recordset(null::public.school_settings, p_rows) as x
    where x.key in ('duty_module', 'custom_categories')
    on conflict (key) do update set value = excluded.value;
    get diagnostics v_count = row_count;
  elsif p_table = 'duty_reports' then
    if not p_allow_owner_overwrite then raise exception 'admin only' using errcode = '42501'; end if;
    insert into public.duty_reports (id, date_str, day_num, period, class_name, subject, teacher_name, reported_by, status, reviewed_by, reviewed_at, created_at)
    select x.id, x.date_str, x.day_num, x.period, x.class_name, x.subject, x.teacher_name, x.reported_by, x.status, x.reviewed_by, x.reviewed_at, x.created_at
    from jsonb_populate_recordset(null::public.duty_reports, p_rows) as x
    on conflict (id) do update set
      date_str = excluded.date_str, day_num = excluded.day_num, period = excluded.period,
      class_name = excluded.class_name, subject = excluded.subject, teacher_name = excluded.teacher_name,
      reported_by = excluded.reported_by, status = excluded.status, reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at, created_at = excluded.created_at;
    get diagnostics v_count = row_count;
  else
    raise exception 'table not allowed' using errcode = '22023';
  end if;

  if p_table in ('attendance', 'behaviors') then
    get diagnostics v_count = row_count;
    if v_count <> v_expected then
      raise exception 'record ownership conflict; no rows saved' using errcode = '42501';
    end if;
  end if;
  return v_count;
end;
$function$;

revoke all on function public.app_data_gateway_write_records(text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.app_data_gateway_write_records(text, jsonb, boolean) to service_role;
