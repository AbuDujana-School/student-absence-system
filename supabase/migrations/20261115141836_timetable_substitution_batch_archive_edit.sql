create or replace function public.replace_timetable_substitution_batch_with_reason(p_payload jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp
as $function$
declare
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_include_other boolean := coalesce((p_payload->>'include_other_departments')::boolean,false);
  v_items jsonb := p_payload->'assignments';
  v_item jsonb;
  v_assignment_id uuid;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if v_actor_name='' or v_actor_type not in ('admin','teacher','custom')
    or coalesce(jsonb_typeof(v_items),'')<>'array'
    or jsonb_array_length(v_items)<1 or jsonb_array_length(v_items)>500 then
    raise exception 'قائمة تعديلات الاحتياط غير مكتملة أو غير صالحة.';
  end if;
  if (select count(distinct value->>'assignmentId') from jsonb_array_elements(v_items))<>jsonb_array_length(v_items) then
    raise exception 'توجد سجلات مكررة في طلب تعديل الأرشيف.';
  end if;
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_assignment_id:=nullif(v_item->>'assignmentId','')::uuid;
    if v_assignment_id is null or btrim(coalesce(v_item->>'substituteTeacherName',''))='' then
      raise exception 'كل تعديل يجب أن يتضمن سجل الاحتياط واسم البديل.';
    end if;
    v_result:=public.replace_timetable_substitution_with_reason(jsonb_build_object(
      'assignment_id',v_assignment_id,'substitute_teacher_name',v_item->>'substituteTeacherName',
      'reserve_reason',v_item->>'reserveReason','actor_name',v_actor_name,'actor_type',v_actor_type,
      'include_other_departments',v_include_other
    ));
    v_results:=v_results||jsonb_build_array(v_result);v_count:=v_count+1;
  end loop;
  return jsonb_build_object('ok',true,'updated_count',v_count,'replacements',v_results,'atomic',true);
end;
$function$;

revoke all on function public.replace_timetable_substitution_batch_with_reason(jsonb) from public, anon, authenticated;
grant execute on function public.replace_timetable_substitution_batch_with_reason(jsonb) to service_role;