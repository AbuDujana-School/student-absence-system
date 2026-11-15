create table if not exists public.timetable_reserve_stats_access (
  principal_type text not null check (principal_type in ('teacher','custom')),
  principal_name text not null check (length(btrim(principal_name)) between 1 and 160),
  granted_by text not null check (length(btrim(granted_by)) between 1 and 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (principal_type, principal_name)
);

alter table public.timetable_reserve_stats_access enable row level security;
revoke all on table public.timetable_reserve_stats_access from public, anon, authenticated;
grant all on table public.timetable_reserve_stats_access to service_role;

create or replace function public.set_timetable_reserve_stats_access(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_grants jsonb := p_payload->'grants';
  v_item jsonb;
  v_type text;
  v_name text;
  v_enabled boolean;
  v_target_role text;
  v_enabled_count integer := 0;
begin
  if v_actor_name='' or coalesce(jsonb_typeof(v_grants),'')<>'array'
    or jsonb_array_length(v_grants)>500 then
    raise exception 'قائمة صلاحيات إحصائيات الاحتياط غير صالحة.';
  end if;

  if (select count(distinct (value->>'principal_type')||':'||(value->>'principal_name'))
      from jsonb_array_elements(v_grants)) <> jsonb_array_length(v_grants) then
    raise exception 'توجد حسابات مكررة في قائمة الصلاحيات.';
  end if;

  for v_item in select value from jsonb_array_elements(v_grants) loop
    v_type := coalesce(v_item->>'principal_type','');
    v_name := left(btrim(coalesce(v_item->>'principal_name','')),160);
    if v_type not in ('teacher','custom') or v_name='' or jsonb_typeof(v_item->'enabled')<>'boolean' then
      raise exception 'توجد بيانات حساب غير مكتملة في قائمة الصلاحيات.';
    end if;
    v_enabled := (v_item->>'enabled')::boolean;

    select role into v_target_role from public.teachers where name=v_name;
    if not found or (v_type='teacher' and v_target_role<>'teacher')
      or (v_type='custom' and v_target_role<>'custom') then
      raise exception 'الحساب المحدد غير موجود أو نوعه لا يطابق الصلاحية: %', v_name;
    end if;

    if v_enabled then
      insert into public.timetable_reserve_stats_access(
        principal_type,principal_name,granted_by,created_at,updated_at
      ) values (v_type,v_name,v_actor_name,now(),now())
      on conflict (principal_type,principal_name) do update
        set granted_by=excluded.granted_by,updated_at=now();
      v_enabled_count := v_enabled_count + 1;
    else
      delete from public.timetable_reserve_stats_access
      where principal_type=v_type and principal_name=v_name;
    end if;
  end loop;

  return jsonb_build_object('ok',true,'enabled_count',v_enabled_count);
end;
$function$;

revoke all on function public.set_timetable_reserve_stats_access(jsonb) from public, anon, authenticated;
grant execute on function public.set_timetable_reserve_stats_access(jsonb) to service_role;
