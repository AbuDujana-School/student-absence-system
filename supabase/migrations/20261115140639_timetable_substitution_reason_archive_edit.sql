alter table public.timetable_assignments
  add column if not exists reserve_reason text not null default '-';

update public.timetable_assignments
set reserve_reason = '-'
where reserve_reason is null or btrim(reserve_reason) = '';

create or replace function public.create_timetable_substitution_with_reason(p_payload jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp
as $function$
declare
  v_reason text := left(btrim(coalesce(p_payload->>'reserve_reason','')),500);
  v_result jsonb;
  v_assignment_id uuid;
begin
  v_result := public.create_timetable_substitution(p_payload);
  v_assignment_id := nullif(v_result->>'assignment_id','')::uuid;
  if v_assignment_id is null then raise exception 'تعذر إنشاء سجل تكليف الاحتياط.'; end if;
  update public.timetable_assignments set reserve_reason = coalesce(nullif(v_reason,''),'-') where id = v_assignment_id;
  update public.timetable_assignment_audit
  set after_data = coalesce(after_data,'{}'::jsonb) || jsonb_build_object('reserve_reason',coalesce(nullif(v_reason,''),'-'))
  where id = (select id from public.timetable_assignment_audit where assignment_id=v_assignment_id and action='created' order by created_at desc limit 1);
  return v_result || jsonb_build_object('reserve_reason',coalesce(nullif(v_reason,''),'-'));
end;
$function$;

create or replace function public.create_timetable_substitution_batch_with_reason(p_payload jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp
as $function$
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
  v_result jsonb;
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
    or jsonb_array_length(v_items)>500 then raise exception 'بيانات التوزيع الجماعي غير مكتملة أو غير صالحة.'; end if;
  if (select count(distinct value) from jsonb_array_elements_text(v_absent_names))<>jsonb_array_length(v_absent_names) then
    raise exception 'توجد أسماء معلمين غائبين مكررة في القائمة.';
  end if;
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_absent_name:=left(btrim(coalesce(v_item->>'absentTeacherName','')),160);
    v_substitute_name:=left(btrim(coalesce(v_item->>'substituteTeacherName','')),160);
    if v_absent_name='' or v_substitute_name='' or not (v_absent_names ? v_absent_name) then
      raise exception 'كل حصة يجب أن ترتبط بأحد المعلمين الغائبين المحددين.';
    end if;
    if(v_absent_names ? v_substitute_name) then
      raise exception 'لا يمكن تكليف معلم محدد كغائب بتغطية حصة غياب أخرى في اليوم نفسه.';
    end if;
    v_result:=public.create_timetable_substitution_with_reason(jsonb_build_object(
      'version_id',v_version_id,'weekday',v_weekday,'period',v_item->>'period',
      'assignment_date',v_date,'absent_teacher_name',v_absent_name,'substitute_teacher_name',v_substitute_name,
      'actor_name',v_actor_name,'actor_type',v_actor_type,'include_other_departments',v_include_other,
      'reserve_reason',v_item->>'reserveReason'
    ));
    v_results:=v_results||jsonb_build_array(v_result);v_count:=v_count+1;
  end loop;
  return jsonb_build_object('created_count',v_count,'assignments',v_results,'atomic',true);
end;
$function$;

create or replace function public.replace_timetable_substitution_with_reason(p_payload jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp
as $function$
declare
  v_assignment_id uuid := nullif(p_payload->>'assignment_id','')::uuid;
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_substitute_name text := left(btrim(coalesce(p_payload->>'substitute_teacher_name','')),160);
  v_reason text := left(btrim(coalesce(p_payload->>'reserve_reason','')),500);
  v_old public.timetable_assignments%rowtype;
  v_cancel jsonb;
  v_created jsonb;
begin
  if v_assignment_id is null or v_actor_name='' or v_actor_type not in ('admin','teacher','custom') or v_substitute_name='' then
    raise exception 'بيانات تعديل تكليف الاحتياط غير مكتملة.';
  end if;
  select * into v_old from public.timetable_assignments where id=v_assignment_id and assignment_type='substitution' for update;
  if not found then raise exception 'تكليف الاحتياط المطلوب غير موجود.'; end if;
  if v_old.status not in ('assigned','confirmed') then raise exception 'لا يمكن تعديل تكليف مكتمل أو ملغى.'; end if;
  v_cancel:=public.cancel_timetable_substitution(jsonb_build_object('assignment_id',v_assignment_id,'actor_name',v_actor_name,'actor_type',v_actor_type));
  v_created:=public.create_timetable_substitution_with_reason(jsonb_build_object(
    'version_id',v_old.version_id,'weekday',v_old.weekday,'period',v_old.period,'assignment_date',v_old.assignment_date,
    'absent_teacher_name',v_old.absent_teacher_name,'substitute_teacher_name',v_substitute_name,
    'actor_name',v_actor_name,'actor_type',v_actor_type,
    'include_other_departments',coalesce((p_payload->>'include_other_departments')::boolean,false),'reserve_reason',v_reason
  ));
  return jsonb_build_object('ok',true,'previous_assignment_id',v_assignment_id,'replacement',v_created,'previous_status',v_cancel->>'status');
end;
$function$;

revoke all on function public.create_timetable_substitution_with_reason(jsonb) from public, anon, authenticated;
revoke all on function public.create_timetable_substitution_batch_with_reason(jsonb) from public, anon, authenticated;
revoke all on function public.replace_timetable_substitution_with_reason(jsonb) from public, anon, authenticated;
grant execute on function public.create_timetable_substitution_with_reason(jsonb) to service_role;
grant execute on function public.create_timetable_substitution_batch_with_reason(jsonb) to service_role;
grant execute on function public.replace_timetable_substitution_with_reason(jsonb) to service_role;
