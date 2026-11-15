create or replace function public.reassign_timetable_substitution_absent_with_reason(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_assignment_id uuid := nullif(p_payload->>'assignment_id','')::uuid;
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_absent_name text := left(btrim(coalesce(p_payload->>'absent_teacher_name','')),160);
  v_substitute_name text := left(btrim(coalesce(p_payload->>'substitute_teacher_name','')),160);
  v_reason text := left(btrim(coalesce(p_payload->>'reserve_reason','')),500);
  v_include_other boolean := coalesce((p_payload->>'include_other_departments')::boolean,false);
  v_old public.timetable_assignments%rowtype;
  v_cancel jsonb;
  v_created jsonb;
begin
  if v_assignment_id is null or v_actor_name='' or v_actor_type not in ('admin','teacher','custom')
    or v_absent_name='' or v_substitute_name='' then
    raise exception 'بيانات تعديل تكليف الاحتياط غير مكتملة.';
  end if;

  select * into v_old
  from public.timetable_assignments
  where id=v_assignment_id and assignment_type='substitution'
  for update;
  if not found then raise exception 'تكليف الاحتياط المطلوب غير موجود.'; end if;
  if v_old.status not in ('assigned','confirmed') then
    raise exception 'لا يمكن تعديل تكليف مكتمل أو ملغى.';
  end if;

  if v_absent_name=v_old.absent_teacher_name then
    return public.replace_timetable_substitution_with_reason(jsonb_build_object(
      'assignment_id',v_assignment_id,'substitute_teacher_name',v_substitute_name,
      'reserve_reason',v_reason,'actor_name',v_actor_name,'actor_type',v_actor_type,
      'include_other_departments',v_include_other
    ));
  end if;

  -- Cancel then recreate inside the same transaction: ledger reversals and audit
  -- entries remain consistent, and any validation failure rolls the whole change back.
  v_cancel:=public.cancel_timetable_substitution(jsonb_build_object(
    'assignment_id',v_assignment_id,'actor_name',v_actor_name,'actor_type',v_actor_type
  ));
  v_created:=public.create_timetable_substitution_with_reason(jsonb_build_object(
    'version_id',v_old.version_id,'weekday',v_old.weekday,'period',v_old.period,
    'assignment_date',v_old.assignment_date,'absent_teacher_name',v_absent_name,
    'substitute_teacher_name',v_substitute_name,'actor_name',v_actor_name,
    'actor_type',v_actor_type,'include_other_departments',v_include_other,
    'reserve_reason',v_reason
  ));
  return jsonb_build_object(
    'ok',true,'previous_assignment_id',v_assignment_id,
    'replacement',v_created,'previous_status',v_cancel->>'status',
    'absent_teacher_changed',true
  );
end;
$function$;

revoke all on function public.reassign_timetable_substitution_absent_with_reason(jsonb) from public, anon, authenticated;
grant execute on function public.reassign_timetable_substitution_absent_with_reason(jsonb) to service_role;
