-- Persist absence reasons atomically with batch reserve creation and correction.
CREATE OR REPLACE FUNCTION public.create_timetable_substitution_batch_with_reason(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_version_id uuid := nullif(p_payload->>'version_id','')::uuid;
  v_weekday text := p_payload->>'weekday';
  v_date date := nullif(p_payload->>'assignment_date','')::date;
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_include_other boolean := coalesce((p_payload->>'include_other_departments')::boolean,false);
  v_absent_names jsonb := p_payload->'absent_teacher_names';
  v_items jsonb := p_payload->'assignments';
  v_item jsonb;
  v_absent_name text;
  v_substitute_name text;
  v_absence_reason text;
  v_result jsonb;
  v_assignment_id uuid;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if v_version_id is null or v_date is null
    or v_weekday not in ('الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس')
    or v_weekday is distinct from (case extract(dow from v_date)
      when 0 then 'الأحد' when 1 then 'الاثنين' when 2 then 'الثلاثاء'
      when 3 then 'الأربعاء' when 4 then 'الخميس' else 'خارج أيام الدراسة' end)
    or v_actor_name='' or v_actor_type not in ('admin','teacher','custom')
    or coalesce(jsonb_typeof(v_absent_names),'')<>'array' or jsonb_array_length(v_absent_names)<1
    or jsonb_array_length(v_absent_names)>100
    or coalesce(jsonb_typeof(v_items),'')<>'array' or jsonb_array_length(v_items)<1
    or jsonb_array_length(v_items)>500 then
    raise exception 'بيانات التوزيع الجماعي غير مكتملة أو غير صالحة.';
  end if;
  if (select count(distinct value) from jsonb_array_elements_text(v_absent_names))<>jsonb_array_length(v_absent_names) then
    raise exception 'توجد أسماء معلمين غائبين مكررة في القائمة.';
  end if;
  for v_item in select value from jsonb_array_elements(v_items)
  loop
    v_absent_name:=left(btrim(coalesce(v_item->>'absentTeacherName','')),160);
    v_substitute_name:=left(btrim(coalesce(v_item->>'substituteTeacherName','')),160);
    v_absence_reason:=left(btrim(coalesce(v_item->>'absenceReason','')),500);
    if v_absent_name='' or v_substitute_name='' or not (v_absent_names ? v_absent_name) then
      raise exception 'كل حصة يجب أن ترتبط بأحد المعلمين الغائبين المحددين.';
    end if;
    if(v_absent_names ? v_substitute_name) then
      raise exception 'لا يمكن تكليف معلم محدد كغائب بتغطية حصة غياب أخرى في اليوم نفسه.';
    end if;
    v_result:=public.create_timetable_substitution_with_reason(jsonb_build_object(
      'version_id',v_version_id,'weekday',v_weekday,'period',v_item->>'period',
      'assignment_date',v_date,'absent_teacher_name',v_absent_name,
      'substitute_teacher_name',v_substitute_name,'actor_name',v_actor_name,
      'actor_type',v_actor_type,'include_other_departments',v_include_other,
      'reserve_reason',v_item->>'reserveReason'
    ));
    v_assignment_id:=nullif(v_result->>'assignment_id','')::uuid;
    if v_assignment_id is null then raise exception 'تعذر إنشاء سجل تكليف الاحتياط.'; end if;
    update public.timetable_assignments
      set absence_reason=coalesce(nullif(v_absence_reason,''),'-')
      where id=v_assignment_id;
    update public.timetable_assignment_audit
      set after_data=coalesce(after_data,'{}'::jsonb)||jsonb_build_object('absence_reason',coalesce(nullif(v_absence_reason,''),'-'))
      where id=(select id from public.timetable_assignment_audit
        where assignment_id=v_assignment_id and action='created' order by created_at desc limit 1);
    v_result:=v_result||jsonb_build_object('absence_reason',coalesce(nullif(v_absence_reason,''),'-'));
    v_results:=v_results||jsonb_build_array(v_result);
    v_count:=v_count+1;
  end loop;
  return jsonb_build_object('created_count',v_count,'assignments',v_results,'atomic',true);
end;
$function$;


CREATE OR REPLACE FUNCTION public.replace_timetable_substitution_batch_with_reason(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_include_other boolean := coalesce((p_payload->>'include_other_departments')::boolean,false);
  v_items jsonb := p_payload->'assignments';
  v_item jsonb;
  v_assignment_id uuid;
  v_new_assignment_id uuid;
  v_old public.timetable_assignments%rowtype;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_absent_name text;
  v_absence_reason text;
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
    select * into v_old from public.timetable_assignments
      where id=v_assignment_id and assignment_type='substitution' for update;
    if not found then raise exception 'تعذر العثور على أحد سجلات الاحتياط المعدلة.'; end if;
    v_absent_name:=coalesce(nullif(btrim(coalesce(v_item->>'absentTeacherName','')),''),v_old.absent_teacher_name);
    v_absence_reason:=coalesce(nullif(left(btrim(coalesce(v_item->>'absenceReason','')),500),''),v_old.absence_reason,'-');
    v_result:=public.reassign_timetable_substitution_absent_with_reason(jsonb_build_object(
      'assignment_id',v_assignment_id,
      'absent_teacher_name',v_absent_name,
      'period',coalesce(v_item->>'period',v_old.period::text),
      'substitute_teacher_name',v_item->>'substituteTeacherName',
      'reserve_reason',v_item->>'reserveReason',
      'actor_name',v_actor_name,'actor_type',v_actor_type,
      'include_other_departments',v_include_other
    ));
    v_new_assignment_id:=nullif(v_result->'replacement'->>'assignment_id','')::uuid;
    if v_new_assignment_id is not null then
      update public.timetable_assignments set absence_reason=v_absence_reason where id=v_new_assignment_id;
      update public.timetable_assignment_audit
        set after_data=coalesce(after_data,'{}'::jsonb)||jsonb_build_object('absence_reason',v_absence_reason)
        where id=(select id from public.timetable_assignment_audit
          where assignment_id=v_new_assignment_id and action='created' order by created_at desc limit 1);
    end if;
    v_result:=v_result||jsonb_build_object('absence_reason',v_absence_reason);
    v_results:=v_results||jsonb_build_array(v_result);
    v_count:=v_count+1;
  end loop;
  return jsonb_build_object('ok',true,'updated_count',v_count,'replacements',v_results,'atomic',true);
end;
$function$;


revoke all on function public.create_timetable_substitution_batch_with_reason(jsonb) from public, anon, authenticated;
grant execute on function public.create_timetable_substitution_batch_with_reason(jsonb) to service_role;
revoke all on function public.replace_timetable_substitution_batch_with_reason(jsonb) from public, anon, authenticated;
grant execute on function public.replace_timetable_substitution_batch_with_reason(jsonb) to service_role;
