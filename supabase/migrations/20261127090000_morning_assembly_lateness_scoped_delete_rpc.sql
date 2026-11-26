-- Allow the authenticated morning-assembly edge function to remove exactly one
-- selected student's record without granting direct DELETE to service_role.
-- The edge function authenticates the school session and enforces the existing
-- duty/time permissions before calling this narrowly scoped RPC.

create or replace function public.delete_morning_assembly_lateness_record(
  p_record_id uuid,
  p_student_id bigint,
  p_late_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_deleted_records bigint := 0;
begin
  if p_record_id is null or p_student_id is null or p_late_date is null then
    raise exception using
      errcode = '22004',
      message = 'بيانات سجل التأخر المطلوب إلغاؤه غير مكتملة.';
  end if;

  delete from public.morning_assembly_lateness
  where id = p_record_id
    and student_id = p_student_id
    and late_date = p_late_date;

  get diagnostics v_deleted_records = row_count;

  return jsonb_build_object(
    'ok', v_deleted_records = 1,
    'deleted_records', v_deleted_records
  );
end;
$function$;

revoke all on function public.delete_morning_assembly_lateness_record(uuid, bigint, date) from public, anon, authenticated, service_role;
grant execute on function public.delete_morning_assembly_lateness_record(uuid, bigint, date) to service_role;
