create or replace function public.app_data_gateway_set_pin_record(
  p_target_type text,
  p_target_name text,
  p_hash text,
  p_salt text,
  p_must_change_pin boolean default false
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_count integer;
begin
  if p_hash !~ '^[a-fA-F0-9]{64}$' or p_salt !~ '^[a-fA-F0-9]{32}$' then
    raise exception 'invalid credential record' using errcode = '22023';
  end if;

  if p_target_type = 'admin' then
    if p_target_name <> 'مدير النظام العام' then
      raise exception 'invalid administrator identity' using errcode = '42501';
    end if;
    insert into public.school_settings (key, value)
    values ('admin_pin', jsonb_build_object('hash', lower(p_hash), 'salt', lower(p_salt)))
    on conflict (key) do update set value = excluded.value;
    get diagnostics v_count = row_count;
    return v_count;
  elsif p_target_type in ('teacher', 'custom') then
    update public.teachers
    set pin_hash = lower(p_hash),
        pin_salt = lower(p_salt),
        must_change_pin = coalesce(p_must_change_pin, false),
        permissions = jsonb_set(
          coalesce(permissions, '{}'::jsonb),
          '{mustChangePin}',
          to_jsonb(coalesce(p_must_change_pin, false)),
          true
        )
    where name = p_target_name and role = p_target_type;
    get diagnostics v_count = row_count;
    return v_count;
  end if;

  raise exception 'target type not allowed' using errcode = '22023';
end;
$function$;

revoke all on function public.app_data_gateway_set_pin_record(text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.app_data_gateway_set_pin_record(text, text, text, text, boolean) to service_role;
