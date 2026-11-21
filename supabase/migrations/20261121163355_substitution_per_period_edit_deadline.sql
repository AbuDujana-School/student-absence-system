-- Allow reserve coordinators to edit or delete each assignment until that lesson's end time.
-- The deadline follows school_settings.period_timings; legacy HH:MM starts use the shortest
-- consecutive-period interval, so longer recess gaps do not extend the lesson itself.
CREATE OR REPLACE FUNCTION public.timetable_substitution_period_edit_deadline(p_assignment_date date, p_period integer)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_timings jsonb; v_item jsonb; v_start_text text; v_end_text text; v_duration_text text;
v_start_minutes integer; v_end_minutes integer; v_duration integer;
BEGIN
  IF p_assignment_date IS NULL OR p_period NOT BETWEEN 1 AND 8 THEN RETURN NULL; END IF;
  SELECT value INTO v_timings FROM public.school_settings WHERE key='period_timings';
  IF coalesce(jsonb_typeof(v_timings),'') <> 'object' THEN RETURN NULL; END IF;
  v_item := v_timings -> p_period::text;
  IF jsonb_typeof(v_item)='string' THEN v_start_text := v_item #>> '{}';
  ELSIF jsonb_typeof(v_item)='object' THEN
    v_start_text := v_item ->> 'start'; v_end_text := v_item ->> 'end';
    v_duration_text := coalesce(v_item ->> 'durationMinutes',v_item ->> 'duration_minutes');
  ELSE RETURN NULL; END IF;
  IF v_start_text !~ '^([01]?\d|2[0-3]):[0-5]\d$' THEN RETURN NULL; END IF;
  v_start_minutes := split_part(v_start_text,':',1)::integer*60+split_part(v_start_text,':',2)::integer;
  IF v_end_text IS NOT NULL AND v_end_text <> '' THEN
    IF v_end_text !~ '^([01]?\d|2[0-3]):[0-5]\d$' THEN RETURN NULL; END IF;
    v_end_minutes := split_part(v_end_text,':',1)::integer*60+split_part(v_end_text,':',2)::integer;
    v_duration := v_end_minutes-v_start_minutes;
  ELSIF coalesce(v_duration_text,'') ~ '^\d{1,3}$' THEN v_duration := v_duration_text::integer;
  ELSE
    WITH starts AS (
      SELECT key::integer AS period_no,
        CASE jsonb_typeof(value) WHEN 'string' THEN value #>> '{}' WHEN 'object' THEN value ->> 'start' ELSE NULL END AS start_text
      FROM jsonb_each(v_timings) WHERE key ~ '^[1-8]$'
    ), minutes AS (
      SELECT period_no,split_part(start_text,':',1)::integer*60+split_part(start_text,':',2)::integer AS start_minute
      FROM starts WHERE start_text ~ '^([01]?\d|2[0-3]):[0-5]\d$'
    ), gaps AS (
      SELECT lead(start_minute) OVER (ORDER BY period_no)-start_minute AS gap FROM minutes
    )
    SELECT min(gap) INTO v_duration FROM gaps WHERE gap>0;
  END IF;
  IF v_duration IS NULL OR v_duration<=0 OR v_duration>180 THEN RETURN NULL; END IF;
  RETURN (p_assignment_date::timestamp+make_interval(mins=>v_start_minutes+v_duration)) AT TIME ZONE 'Asia/Muscat';
END;
$function$;

CREATE OR REPLACE FUNCTION public.timetable_substitution_period_is_open(p_assignment_date date, p_period integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT coalesce(p_assignment_date >= (now() AT TIME ZONE 'Asia/Muscat')::date
   AND now() < public.timetable_substitution_period_edit_deadline(p_assignment_date,p_period),false);
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

  if v_actor_type='admin' then
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
    v_before,jsonb_build_object('status','cancelled','correction_scope','same_day')
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
begin
  if v_assignment_id is null or v_actor_name='' or v_actor_type not in ('admin','teacher','custom') or v_substitute_name='' then
    raise exception 'بيانات تعديل تكليف الاحتياط غير مكتملة.';
  end if;

  select * into v_old from public.timetable_assignments
    where id=v_assignment_id and assignment_type='substitution' for update;
  if not found then raise exception 'تكليف الاحتياط المطلوب غير موجود.'; end if;
  if v_old.status not in ('assigned','confirmed') then
    raise exception 'لا يمكن تعديل تكليف مكتمل أو ملغى.';
  end if;
  v_period:=coalesce(nullif(p_payload->>'period','')::integer,v_old.period::integer);
  if v_period not between 1 and 8 then raise exception 'رقم الحصة المحدد غير صالح.'; end if;
  if v_actor_type='admin' then
    if v_old.assignment_date is distinct from (now() at time zone 'Asia/Muscat')::date then
      raise exception 'يمكن لمدير النظام تعديل هذا السجل خلال يوم تنفيذه فقط.';
    end if;
  elsif not public.timetable_substitution_period_is_open(v_old.assignment_date,v_old.period::integer)
     or not public.timetable_substitution_period_is_open(v_old.assignment_date,v_period) then
    raise exception 'انتهت مهلة التعديل لهذه الحصة أو للحصة البديلة؛ يجب إجراء التعديل قبل نهاية وقت الحصة.';
  end if;

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
    set reserve_created_at=coalesce(v_old.reserve_created_at,v_old.created_at)
    where id=v_new_id;

  return jsonb_build_object(
    'ok',true,'previous_assignment_id',v_assignment_id,'replacement',v_created,
    'previous_status',v_cancel->>'status',
    'reserve_created_at',coalesce(v_old.reserve_created_at,v_old.created_at)
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
begin
  if v_assignment_id is null or v_actor_name='' or v_actor_type not in ('admin','teacher','custom')
    or v_absent_name='' or v_substitute_name='' then
    raise exception 'بيانات تعديل تكليف الاحتياط غير مكتملة.';
  end if;

  select * into v_old from public.timetable_assignments
    where id=v_assignment_id and assignment_type='substitution' for update;
  if not found then raise exception 'تكليف الاحتياط المطلوب غير موجود.'; end if;
  if v_old.status not in ('assigned','confirmed') then
    raise exception 'لا يمكن تعديل تكليف مكتمل أو ملغى.';
  end if;
  v_period:=coalesce(nullif(p_payload->>'period','')::integer,v_old.period::integer);
  if v_period not between 1 and 8 then raise exception 'رقم الحصة المحدد غير صالح.'; end if;
  if v_actor_type='admin' then
    if v_old.assignment_date is distinct from (now() at time zone 'Asia/Muscat')::date then
      raise exception 'يمكن لمدير النظام تعديل هذا السجل خلال يوم تنفيذه فقط.';
    end if;
  elsif not public.timetable_substitution_period_is_open(v_old.assignment_date,v_old.period::integer)
     or not public.timetable_substitution_period_is_open(v_old.assignment_date,v_period) then
    raise exception 'انتهت مهلة التعديل لهذه الحصة أو للحصة البديلة؛ يجب إجراء التعديل قبل نهاية وقت الحصة.';
  end if;

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
    set reserve_created_at=coalesce(v_old.reserve_created_at,v_old.created_at)
    where id=v_new_id;

  return jsonb_build_object(
    'ok',true,'previous_assignment_id',v_assignment_id,
    'replacement',v_created,'previous_status',v_cancel->>'status',
    'absent_teacher_changed',true,'period_changed',v_period<>v_old.period
  );
end;
$function$;
REVOKE ALL ON FUNCTION public.timetable_substitution_period_edit_deadline(date,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.timetable_substitution_period_is_open(date,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.timetable_substitution_period_edit_deadline(date,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.timetable_substitution_period_is_open(date,integer) TO service_role;
