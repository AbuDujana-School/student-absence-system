-- Reserve records remain editable through the end of their assignment date in Asia/Muscat.
-- New assignments and direct deletes retain their existing per-period deadline.
CREATE OR REPLACE FUNCTION public.timetable_substitution_assignment_day_is_open(p_assignment_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT coalesce(p_assignment_date >= (now() AT TIME ZONE 'Asia/Muscat')::date,false);
$function$;

CREATE OR REPLACE FUNCTION public.timetable_substitution_period_is_open(p_assignment_date date, p_period integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT CASE
   WHEN coalesce(current_setting('app.allow_reserve_edit_until_day_end',true),'false')='true'
     THEN coalesce(p_assignment_date >= (now() AT TIME ZONE 'Asia/Muscat')::date,false)
   ELSE coalesce(p_assignment_date >= (now() AT TIME ZONE 'Asia/Muscat')::date
     AND now() < public.timetable_substitution_period_edit_deadline(p_assignment_date,p_period),false)
 END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_timetable_substitution(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_assignment_id uuid := nullif(p_payload->>'assignment_id','')::uuid;
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_assignment public.timetable_assignments%rowtype;
  v_absent_department text;
  v_actor_department text;
  v_actor_can_manage boolean := false;
  v_before jsonb;
  v_active_version_id uuid;
begin
  if v_assignment_id is null or v_actor_name='' or v_actor_type not in ('admin','teacher','custom') then
    raise exception 'بيانات إلغاء تكليف الاحتياط غير صالحة.';
  end if;

  select * into v_assignment from public.timetable_assignments
    where id=v_assignment_id and assignment_type='substitution' for update;
  if not found then raise exception 'تكليف الاحتياط غير موجود.'; end if;
  if v_assignment.status='cancelled' then
    return jsonb_build_object('assignment_id',v_assignment.id,'status','cancelled','already_cancelled',true);
  end if;
  if v_assignment.status not in ('assigned','confirmed')
    and not (v_assignment.status='completed' and lower(coalesce(p_payload->>'force_points_reversal','false'))='true') then
    raise exception 'لا يمكن إلغاء تكليف مكتمل إلا ضمن حذف توزيع الغياب بالكامل.';
  end if;

  if coalesce(current_setting('app.allow_reserve_edit_until_day_end',true),'false')='true' then
    if not public.timetable_substitution_assignment_day_is_open(v_assignment.assignment_date) then
      raise exception 'انتهى يوم هذا التوزيع؛ أصبح السجل في الأرشيف للقراءة فقط.';
    end if;
  elsif v_actor_type='admin' then
    if v_assignment.assignment_date is distinct from (now() at time zone 'Asia/Muscat')::date then
      raise exception 'يمكن لمدير النظام إدارة هذا السجل خلال يوم تنفيذه فقط.';
    end if;
  elsif not public.timetable_substitution_period_is_open(v_assignment.assignment_date,v_assignment.period::integer) then
    raise exception 'انتهت مهلة التعديل والحذف لهذه الحصة؛ يسمح بذلك حتى نهاية وقت الحصة المحدد في الجدول.';
  end if;
  select id into v_active_version_id from public.timetable_weekly_versions
    where status='active' limit 1;
  if v_active_version_id is null or v_assignment.version_id is distinct from v_active_version_id then
    raise exception 'لا يمكن تعديل سجل مرتبط بإصدار جدول غير نشط.';
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
    'absence_reason',v_assignment.absence_reason,
    'status',v_assignment.status
  );

  if v_actor_type<>'admin' then
    select coalesce(permissions->>'category',permissions->>'department_id',permissions->>'department_name','')
      into v_absent_department from public.teachers
      where name=v_assignment.absent_teacher_name and role='teacher';
    if not found then raise exception 'تعذر التحقق من قسم المعلم الغائب.'; end if;

    select coalesce(permissions->>'category',permissions->>'department_id',permissions->>'department_name',''),
      (v_actor_type='teacher' and role='teacher' and coalesce(permissions->>'reserve','false')='true')
      into v_actor_department,v_actor_can_manage
      from public.teachers where name=v_actor_name and role in ('teacher','custom');
    if not found or v_actor_department='' or v_absent_department='' or
      (v_actor_department<>v_absent_department and not v_actor_can_manage) then
      raise exception 'لا تملك صلاحية إلغاء تكليف هذا القسم.';
    end if;
  end if;

  perform set_config('app.force_substitution_points_reversal',
    case when lower(coalesce(p_payload->>'force_points_reversal','false'))='true' then 'true' else 'false' end,
    true);

  update public.timetable_assignments set status='cancelled',updated_at=now()
    where id=v_assignment.id returning * into v_assignment;
  insert into public.timetable_assignment_audit(
    assignment_id,version_id,action,actor_name,before_data,after_data
  ) values (
    v_assignment.id,v_assignment.version_id,'cancelled',v_actor_name,
    v_before,jsonb_build_object('status','cancelled','correction_scope',case when coalesce(current_setting('app.allow_reserve_edit_until_day_end',true),'false')='true' then 'assignment_day' else 'same_day' end)
  );
  return jsonb_build_object('assignment_id',v_assignment.id,'status',v_assignment.status);
end;
$function$;

CREATE OR REPLACE FUNCTION public.replace_timetable_substitution_with_reason(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_assignment_id uuid := nullif(p_payload->>'assignment_id','')::uuid;
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_substitute_name text := left(btrim(coalesce(p_payload->>'substitute_teacher_name','')),160);
  v_reason text := left(btrim(coalesce(p_payload->>'reserve_reason','')),500);
  v_old public.timetable_assignments%rowtype;
  v_cancel jsonb;
  v_created jsonb;
  v_new_id uuid;
  v_period integer;
  v_absence_reason text;
begin
  if v_assignment_id is null or v_actor_name='' or v_actor_type not in ('admin','teacher','custom') or v_substitute_name='' then
    raise exception 'بيانات تعديل تكليف الاحتياط غير مكتملة.';
  end if;

  select * into v_old from public.timetable_assignments
    where id=v_assignment_id and assignment_type='substitution' for update;
  if not found then raise exception 'تكليف الاحتياط المطلوب غير موجود.'; end if;
  if v_old.status not in ('assigned','confirmed','completed') then
    raise exception 'لا يمكن تعديل تكليف ملغى أو غير نشط.';
  end if;
  v_absence_reason:=coalesce(nullif(btrim(v_old.absence_reason),''),'-');
  v_period:=coalesce(nullif(p_payload->>'period','')::integer,v_old.period::integer);
  if v_period not between 1 and 8 then raise exception 'رقم الحصة المحدد غير صالح.'; end if;
  if not public.timetable_substitution_assignment_day_is_open(v_old.assignment_date) then
    raise exception 'انتهى يوم هذا التوزيع؛ أصبح السجل في الأرشيف للقراءة فقط.';
  end if;
  perform set_config('app.allow_reserve_edit_until_day_end','true',true);

  v_cancel:=public.cancel_timetable_substitution(jsonb_build_object(
    'assignment_id',v_assignment_id,'actor_name',v_actor_name,'actor_type',v_actor_type,
    'force_points_reversal',true
  ));
  v_created:=public.create_timetable_substitution_with_reason(jsonb_build_object(
    'version_id',v_old.version_id,'weekday',v_old.weekday,'period',v_period,
    'assignment_date',v_old.assignment_date,
    'absent_teacher_name',v_old.absent_teacher_name,
    'substitute_teacher_name',v_substitute_name,
    'actor_name',v_actor_name,'actor_type',v_actor_type,
    'include_other_departments',coalesce((p_payload->>'include_other_departments')::boolean,false),
    'reserve_reason',v_reason
  ));
  v_new_id:=nullif(v_created->>'assignment_id','')::uuid;
  if v_new_id is null then raise exception 'تعذر إنشاء سجل الاحتياط المعدل.'; end if;
  update public.timetable_assignments
    set reserve_created_at=coalesce(v_old.reserve_created_at,v_old.created_at),
        absence_reason=v_absence_reason
    where id=v_new_id;
  update public.timetable_assignment_audit
    set after_data=coalesce(after_data,'{}'::jsonb)||jsonb_build_object('absence_reason',v_absence_reason)
    where id=(select id from public.timetable_assignment_audit where assignment_id=v_new_id and action='created' order by created_at desc limit 1);

  return jsonb_build_object(
    'ok',true,'previous_assignment_id',v_assignment_id,'replacement',v_created,
    'previous_status',v_cancel->>'status',
    'reserve_created_at',coalesce(v_old.reserve_created_at,v_old.created_at),
    'absence_reason',v_absence_reason
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.reassign_timetable_substitution_absent_with_reason(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_period integer;
  v_new_id uuid;
  v_absence_reason text;
begin
  if v_assignment_id is null or v_actor_name='' or v_actor_type not in ('admin','teacher','custom')
    or v_absent_name='' or v_substitute_name='' then
    raise exception 'بيانات تعديل تكليف الاحتياط غير مكتملة.';
  end if;

  select * into v_old from public.timetable_assignments
    where id=v_assignment_id and assignment_type='substitution' for update;
  if not found then raise exception 'تكليف الاحتياط المطلوب غير موجود.'; end if;
  if v_old.status not in ('assigned','confirmed','completed') then
    raise exception 'لا يمكن تعديل تكليف ملغى أو غير نشط.';
  end if;
  v_absence_reason:=coalesce(nullif(btrim(v_old.absence_reason),''),'-');
  v_period:=coalesce(nullif(p_payload->>'period','')::integer,v_old.period::integer);
  if v_period not between 1 and 8 then raise exception 'رقم الحصة المحدد غير صالح.'; end if;
  if not public.timetable_substitution_assignment_day_is_open(v_old.assignment_date) then
    raise exception 'انتهى يوم هذا التوزيع؛ أصبح السجل في الأرشيف للقراءة فقط.';
  end if;
  perform set_config('app.allow_reserve_edit_until_day_end','true',true);

  if v_absent_name=v_old.absent_teacher_name then
    return public.replace_timetable_substitution_with_reason(jsonb_build_object(
      'assignment_id',v_assignment_id,'period',v_period,
      'substitute_teacher_name',v_substitute_name,'reserve_reason',v_reason,
      'actor_name',v_actor_name,'actor_type',v_actor_type,
      'include_other_departments',v_include_other
    ));
  end if;

  v_cancel:=public.cancel_timetable_substitution(jsonb_build_object(
    'assignment_id',v_assignment_id,'actor_name',v_actor_name,'actor_type',v_actor_type,
    'force_points_reversal',true
  ));
  v_created:=public.create_timetable_substitution_with_reason(jsonb_build_object(
    'version_id',v_old.version_id,'weekday',v_old.weekday,'period',v_period,
    'assignment_date',v_old.assignment_date,'absent_teacher_name',v_absent_name,
    'substitute_teacher_name',v_substitute_name,'actor_name',v_actor_name,
    'actor_type',v_actor_type,'include_other_departments',v_include_other,
    'reserve_reason',v_reason
  ));
  v_new_id:=nullif(v_created->>'assignment_id','')::uuid;
  if v_new_id is null then raise exception 'تعذر إنشاء سجل الاحتياط المعدل.'; end if;
  update public.timetable_assignments
    set reserve_created_at=coalesce(v_old.reserve_created_at,v_old.created_at),
        absence_reason=v_absence_reason
    where id=v_new_id;
  update public.timetable_assignment_audit
    set after_data=coalesce(after_data,'{}'::jsonb)||jsonb_build_object('absence_reason',v_absence_reason)
    where id=(select id from public.timetable_assignment_audit where assignment_id=v_new_id and action='created' order by created_at desc limit 1);

  return jsonb_build_object(
    'ok',true,'previous_assignment_id',v_assignment_id,
    'replacement',v_created,'previous_status',v_cancel->>'status',
    'absent_teacher_changed',true,'period_changed',v_period<>v_old.period,
    'absence_reason',v_absence_reason
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.timetable_substitution_assignment_day_is_open(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.timetable_substitution_assignment_day_is_open(date) TO service_role;
REVOKE ALL ON FUNCTION public.timetable_substitution_period_is_open(date,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.timetable_substitution_period_is_open(date,integer) TO service_role;
