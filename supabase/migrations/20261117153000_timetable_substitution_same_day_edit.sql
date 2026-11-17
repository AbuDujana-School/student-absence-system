-- Reserve assignments may be corrected throughout their Muscat calendar day.
-- The previous implementation used a rolling 20-hour window; date-boundary checks
-- now consistently use Asia/Muscat and keep all corrections in the audit/points ledger.

create or replace function public.cancel_timetable_substitution(p_payload jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_assignment_id uuid := nullif(p_payload->>'assignment_id','')::uuid;
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_assignment public.timetable_assignments%rowtype;
  v_absent_department text;
  v_actor_department text;
  v_actor_can_manage boolean := false;
  v_before jsonb;
begin
  if v_assignment_id is null or v_actor_name='' or v_actor_type not in ('admin','teacher','custom') then
    raise exception 'بيانات إلغاء تكليف الاحتياط غير صالحة.';
  end if;

  select * into v_assignment
  from public.timetable_assignments
  where id=v_assignment_id and assignment_type='substitution'
  for update;
  if not found then raise exception 'تكليف الاحتياط غير موجود.'; end if;

  if v_assignment.assignment_date is distinct from (now() at time zone 'Asia/Muscat')::date then
    raise exception 'يمكن تعديل أو حذف تكليفات اليوم الحالي فقط، حتى نهاية اليوم بتوقيت عُمان.';
  end if;
  if v_assignment.status='cancelled' then
    return jsonb_build_object('assignment_id',v_assignment.id,'status','cancelled','already_cancelled',true);
  end if;
  if v_assignment.status not in ('assigned','confirmed') then
    raise exception 'لا يمكن إلغاء تكليف مكتمل أو غير نشط.';
  end if;

  v_before := jsonb_build_object(
    'teacher_name',v_assignment.teacher_name,
    'absent_teacher_name',v_assignment.absent_teacher_name,
    'weekday',v_assignment.weekday,
    'period',v_assignment.period,
    'assignment_date',v_assignment.assignment_date,
    'class_sections',v_assignment.class_sections,
    'subject',v_assignment.subject,
    'reserve_reason',v_assignment.reserve_reason,
    'status',v_assignment.status
  );

  if v_actor_type<>'admin' then
    select coalesce(permissions->>'category',permissions->>'department_id',permissions->>'department_name','')
      into v_absent_department
      from public.teachers
      where name=v_assignment.absent_teacher_name and role='teacher';
    if not found then raise exception 'تعذر التحقق من قسم المعلم الغائب.'; end if;

    select coalesce(permissions->>'category',permissions->>'department_id',permissions->>'department_name',''),
      (v_actor_type='teacher' and role='teacher' and coalesce(permissions->>'reserve','false')='true')
      into v_actor_department,v_actor_can_manage
      from public.teachers
      where name=v_actor_name and role in ('teacher','custom');
    if not found or v_actor_department='' or v_absent_department='' or
      (v_actor_department<>v_absent_department and not v_actor_can_manage) then
      raise exception 'لا تملك صلاحية إلغاء تكليف هذا القسم.';
    end if;
  end if;

  update public.timetable_assignments
  set status='cancelled',updated_at=now()
  where id=v_assignment.id
  returning * into v_assignment;

  insert into public.timetable_assignment_audit(
    assignment_id,version_id,action,actor_name,before_data,after_data
  ) values (
    v_assignment.id,v_assignment.version_id,'cancelled',v_actor_name,
    v_before,jsonb_build_object('status','cancelled')
  );

  return jsonb_build_object('assignment_id',v_assignment.id,'status',v_assignment.status);
end;
$function$;

create or replace function public.replace_timetable_substitution_with_reason(p_payload jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_assignment_id uuid := nullif(p_payload->>'assignment_id','')::uuid;
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_substitute_name text := left(btrim(coalesce(p_payload->>'substitute_teacher_name','')),160);
  v_absent_name text := nullif(left(btrim(coalesce(p_payload->>'absent_teacher_name','')),160),'');
  v_period integer := nullif(p_payload->>'period','')::integer;
  v_reason text := left(btrim(coalesce(p_payload->>'reserve_reason','')),500);
  v_old public.timetable_assignments%rowtype;
  v_cancel jsonb;
  v_created jsonb;
  v_new_id uuid;
begin
  if v_assignment_id is null or v_actor_name='' or v_actor_type not in ('admin','teacher','custom') or v_substitute_name='' then
    raise exception 'بيانات تعديل تكليف الاحتياط غير مكتملة.';
  end if;

  select * into v_old
  from public.timetable_assignments
  where id=v_assignment_id and assignment_type='substitution'
  for update;
  if not found then raise exception 'تكليف الاحتياط المطلوب غير موجود.'; end if;

  if v_old.assignment_date is distinct from (now() at time zone 'Asia/Muscat')::date then
    raise exception 'يمكن تعديل تكليفات اليوم الحالي فقط، حتى نهاية اليوم بتوقيت عُمان.';
  end if;
  if v_old.status not in ('assigned','confirmed') then
    raise exception 'لا يمكن تعديل تكليف مكتمل أو ملغى.';
  end if;

  v_absent_name := coalesce(v_absent_name,v_old.absent_teacher_name);
  v_period := coalesce(v_period,v_old.period);
  if v_absent_name='' or v_period not between 1 and 8 then
    raise exception 'حدد المعلم الغائب والحصة بصورة صحيحة.';
  end if;

  -- Cancel and recreate in one transaction. The old row and its audit/ledger
  -- reversals remain intact; the new row derives class/subject from the active timetable.
  v_cancel:=public.cancel_timetable_substitution(jsonb_build_object(
    'assignment_id',v_assignment_id,
    'actor_name',v_actor_name,
    'actor_type',v_actor_type
  ));

  v_created:=public.create_timetable_substitution_with_reason(jsonb_build_object(
    'version_id',v_old.version_id,
    'weekday',v_old.weekday,
    'period',v_period,
    'assignment_date',v_old.assignment_date,
    'absent_teacher_name',v_absent_name,
    'substitute_teacher_name',v_substitute_name,
    'actor_name',v_actor_name,
    'actor_type',v_actor_type,
    'include_other_departments',coalesce((p_payload->>'include_other_departments')::boolean,false),
    'reserve_reason',v_reason
  ));

  v_new_id:=nullif(v_created->>'assignment_id','')::uuid;
  if v_new_id is null then raise exception 'تعذر إنشاء سجل الاحتياط المعدل.'; end if;

  update public.timetable_assignments
  set reserve_created_at=coalesce(v_old.reserve_created_at,v_old.created_at)
  where id=v_new_id;

  return jsonb_build_object(
    'ok',true,
    'previous_assignment_id',v_assignment_id,
    'replacement',v_created,
    'previous_status',v_cancel->>'status',
    'reserve_created_at',coalesce(v_old.reserve_created_at,v_old.created_at),
    'period_changed',v_period<>v_old.period,
    'absent_teacher_changed',v_absent_name<>v_old.absent_teacher_name
  );
end;
$function$;

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
  v_period text := p_payload->>'period';
  v_reason text := left(btrim(coalesce(p_payload->>'reserve_reason','')),500);
begin
  if v_assignment_id is null or v_actor_name='' or v_actor_type not in ('admin','teacher','custom')
    or v_absent_name='' or v_substitute_name='' then
    raise exception 'بيانات تعديل تكليف الاحتياط غير مكتملة.';
  end if;

  return public.replace_timetable_substitution_with_reason(jsonb_build_object(
    'assignment_id',v_assignment_id,
    'absent_teacher_name',v_absent_name,
    'period',v_period,
    'substitute_teacher_name',v_substitute_name,
    'reserve_reason',v_reason,
    'actor_name',v_actor_name,
    'actor_type',v_actor_type,
    'include_other_departments',coalesce((p_payload->>'include_other_departments')::boolean,false)
  ));
end;
$function$;

create or replace function public.replace_timetable_substitution_batch_with_reason(p_payload jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
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
      'assignment_id',v_assignment_id,
      'absent_teacher_name',v_item->>'absentTeacherName',
      'period',v_item->>'period',
      'substitute_teacher_name',v_item->>'substituteTeacherName',
      'reserve_reason',v_item->>'reserveReason',
      'actor_name',v_actor_name,
      'actor_type',v_actor_type,
      'include_other_departments',v_include_other
    ));
    v_results:=v_results||jsonb_build_array(v_result);
    v_count:=v_count+1;
  end loop;

  return jsonb_build_object('ok',true,'updated_count',v_count,'replacements',v_results,'atomic',true);
end;
$function$;

revoke all on function public.cancel_timetable_substitution(jsonb) from public, anon, authenticated;
revoke all on function public.replace_timetable_substitution_with_reason(jsonb) from public, anon, authenticated;
revoke all on function public.reassign_timetable_substitution_absent_with_reason(jsonb) from public, anon, authenticated;
revoke all on function public.replace_timetable_substitution_batch_with_reason(jsonb) from public, anon, authenticated;

grant execute on function public.cancel_timetable_substitution(jsonb) to service_role;
grant execute on function public.replace_timetable_substitution_with_reason(jsonb) to service_role;
grant execute on function public.reassign_timetable_substitution_absent_with_reason(jsonb) to service_role;
grant execute on function public.replace_timetable_substitution_batch_with_reason(jsonb) to service_role;
