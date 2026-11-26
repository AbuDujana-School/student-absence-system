-- Secure, atomic reset of the morning assembly lateness ledger only.
-- Browser roles and service_role retain no direct DELETE/TRUNCATE privilege.
-- The authenticated student-affairs edge function verifies the general-admin PIN
-- twice before invoking this narrowly scoped SECURITY DEFINER function.

create or replace function public.admin_delete_all_morning_assembly_lateness_records(p_actor_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_deleted_records bigint := 0;
begin
  if btrim(coalesce(p_actor_name, '')) <> 'مدير النظام العام' then
    raise exception using
      errcode = '42501',
      message = 'تصفير سجلات الطابور الصباحي متاح لمدير النظام العام فقط.';
  end if;

  lock table public.morning_assembly_lateness in access exclusive mode;
  delete from public.morning_assembly_lateness;
  get diagnostics v_deleted_records = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_records', v_deleted_records
  );
end;
$function$;

revoke all on function public.admin_delete_all_morning_assembly_lateness_records(text) from public, anon, authenticated;
grant execute on function public.admin_delete_all_morning_assembly_lateness_records(text) to service_role;
