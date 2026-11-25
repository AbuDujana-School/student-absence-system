-- Permanently clear saved substitution records only.
-- Weekly timetable versions/cells, duty assignments, other assignments,
-- school settings, permissions, and all student/staff records remain untouched.

create or replace function public.admin_delete_all_timetable_substitution_records(p_actor_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_deleted_assignments bigint := 0;
  v_deleted_audit_rows bigint := 0;
  v_deleted_points_rows bigint := 0;
begin
  if btrim(coalesce(p_actor_name, '')) <> 'مدير النظام العام' then
    raise exception using
      errcode = '42501',
      message = 'تصفير سجلات الاحتياط متاح لمدير النظام العام فقط.';
  end if;

  -- Freeze reserve writes while deleting the linked rows in one transaction.
  lock table public.timetable_assignments,
             public.timetable_assignment_audit,
             public.timetable_substitution_points_ledger
    in share row exclusive mode;

  delete from public.timetable_substitution_points_ledger p
   where exists (
     select 1
       from public.timetable_assignments a
      where a.id = p.assignment_id
        and a.assignment_type = 'substitution'
   );
  get diagnostics v_deleted_points_rows = row_count;

  delete from public.timetable_assignment_audit h
   where exists (
     select 1
       from public.timetable_assignments a
      where a.id = h.assignment_id
        and a.assignment_type = 'substitution'
   );
  get diagnostics v_deleted_audit_rows = row_count;

  delete from public.timetable_assignments
   where assignment_type = 'substitution';
  get diagnostics v_deleted_assignments = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_assignments', v_deleted_assignments,
    'deleted_audit_rows', v_deleted_audit_rows,
    'deleted_points_rows', v_deleted_points_rows
  );
end;
$function$;

revoke all on function public.admin_delete_all_timetable_substitution_records(text) from public, anon, authenticated;
grant execute on function public.admin_delete_all_timetable_substitution_records(text) to service_role;
