-- Prevent reserve coordinators from adding a new assignment after that lesson has ended.
-- Admin creation behavior remains unchanged.
CREATE OR REPLACE FUNCTION public.create_timetable_substitution(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_version_id uuid := nullif(p_payload->>'version_id','')::uuid;
  v_weekday text := p_payload->>'weekday';
  v_period integer := nullif(p_payload->>'period','')::integer;
  v_date date := nullif(p_payload->>'assignment_date','')::date;
  v_absent_name text := left(btrim(coalesce(p_payload->>'absent_teacher_name','')),160);
  v_substitute_name text := left(btrim(coalesce(p_payload->>'substitute_teacher_name','')),160);
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_include_other boolean := coalesce((p_payload->>'include_other_departments')::boolean,false);
  v_active_id uuid;
  v_absent_cell public.timetable_weekly_cells%rowtype;
  v_absent_department text;
  v_candidate_department text;
  v_actor_department text;
  v_actor_can_manage boolean := false;
  v_candidate_free_count integer;
  v_daily_sub_count integer := 0;
  v_assignment public.timetable_assignments%rowtype;
begin
  if v_version_id is null or v_date is null
    or v_weekday not in ('الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس')
    or v_weekday is distinct from (case extract(dow from v_date)
      when 0 then 'الأحد' when 1 then 'الاثنين' when 2 then 'الثلاثاء'
      when 3 then 'الأربعاء' when 4 then 'الخميس' else 'خارج أيام الدراسة' end)
    or v_period is null or v_period not between 1 and 8 or v_absent_name='' or v_substitute_name=''
    or v_actor_name='' or v_actor_type not in ('admin','teacher','custom')
    or v_absent_name=v_substitute_name then
    raise exception 'بيانات تكليف الاحتياط غير مكتملة أو غير صالحة.';
  end if;

  if v_actor_type<>'admin' and not public.timetable_substitution_period_is_open(v_date,v_period) then
    raise exception 'لا يمكن إضافة تكليف بعد انتهاء وقت الحصة المحدد في الجدول.';
  end if;

  -- Serialize all assignments for this substitute on the date before checking the two-cover cap.
  perform pg_advisory_xact_lock(hashtext('timetable_substitution_teacher_day:'||v_substitute_name||':'||v_date::text));
  perform pg_advisory_xact_lock(hashtext('timetable_substitution:'||v_version_id::text||':'||v_date::text||':'||v_period::text));
  select id into v_active_id from public.timetable_weekly_versions
    where id=v_version_id and status='active' for share;
  if v_active_id is null then raise exception 'الجدول المحدد ليس النسخة الأسبوعية النشطة.'; end if;

  select * into v_absent_cell from public.timetable_weekly_cells
    where version_id=v_version_id and matched_teacher_name=v_absent_name
      and weekday=v_weekday and period=v_period and cell_status='teaching';
  if not found then raise exception 'لا توجد حصة تدريس مسجلة للمعلم الغائب في هذه الفترة.'; end if;
  if jsonb_array_length(v_absent_cell.class_sections)=0 or btrim(coalesce(v_absent_cell.subject,''))='' then
    raise exception 'بيانات صف أو مادة الحصة الغائبة غير مكتملة؛ لا يمكن إنشاء تكليف احتياط آمن.';
  end if;

  select coalesce(permissions->>'category',permissions->>'department_id',permissions->>'department_name','')
    into v_absent_department from public.teachers where name=v_absent_name and role='teacher';
  if not found then raise exception 'حساب المعلم الغائب غير موجود.'; end if;

  select coalesce(permissions->>'category',permissions->>'department_id',permissions->>'department_name','')
    into v_candidate_department from public.teachers where name=v_substitute_name and role='teacher';
  if not found then raise exception 'المعلم البديل غير موجود في دليل المعلمين.'; end if;

  if v_actor_type<>'admin' then
    select coalesce(permissions->>'category',permissions->>'department_id',permissions->>'department_name',''),
      (v_actor_type='teacher' and role='teacher' and coalesce(permissions->>'reserve','false')='true')
      into v_actor_department,v_actor_can_manage
      from public.teachers where name=v_actor_name and role in ('teacher','custom');
    if not found or v_actor_department='' or v_absent_department='' or
      (v_actor_department<>v_absent_department and not v_actor_can_manage) then
      raise exception 'لا تملك صلاحية إدارة احتياط هذا القسم.';
    end if;
  end if;

  if not v_include_other and (v_absent_department='' or v_candidate_department='') then
    raise exception 'تعذر التحقق من قسم المعلم الغائب أو البديل. راجع تصنيف المعلمين.';
  end if;
  if not v_include_other and v_candidate_department is distinct from v_absent_department then
    raise exception 'المعلم المرشح من قسم آخر. فعّل خيار إظهار الأقسام الأخرى أولاً.';
  end if;

  select count(*) into v_candidate_free_count
    from public.timetable_weekly_cells
    where version_id=v_version_id and matched_teacher_name=v_substitute_name
      and weekday=v_weekday and period=v_period and cell_status='free';
  if v_candidate_free_count<>1 then raise exception 'المعلم المرشح ليس لديه فراغ مؤكد في هذه الحصة.'; end if;

  if exists (
    select 1 from public.timetable_assignments
    where source_cell_id=v_absent_cell.id and assignment_type='substitution'
      and status in ('assigned','confirmed','completed')
      and (assignment_date=v_date or (assignment_date is null and weekday=v_weekday))
  ) then raise exception 'تم تعيين بديل لهذه الحصة مسبقاً.'; end if;

  if exists (
    select 1 from public.timetable_assignments
    where version_id=v_version_id and teacher_name=v_substitute_name
      and period=v_period and status in ('assigned','confirmed','completed')
      and (assignment_date=v_date or (assignment_date is null and weekday=v_weekday))
  ) then raise exception 'المعلم المرشح لديه تكليف آخر في الحصة نفسها.'; end if;

  select count(*) into v_daily_sub_count
    from public.timetable_assignments
    where teacher_name=v_substitute_name and assignment_type='substitution'
      and status in ('assigned','confirmed','completed')
      and (assignment_date=v_date or (assignment_date is null and version_id=v_version_id and weekday=v_weekday));
  if v_daily_sub_count>=2 then
    raise exception 'وصل المعلم المرشح إلى الحد الأعلى لحصتي احتياط في هذا اليوم.';
  end if;

  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,assignment_date,class_sections,subject,
    absent_teacher_name,source_cell_id,status,created_by
  ) values (
    v_version_id,v_substitute_name,'substitution',v_weekday,v_period::smallint,v_date,
    v_absent_cell.class_sections,v_absent_cell.subject,v_absent_name,v_absent_cell.id,'assigned',v_actor_name
  ) returning * into v_assignment;

  insert into public.timetable_assignment_audit(
    assignment_id,version_id,action,actor_name,after_data
  ) values (
    v_assignment.id,v_version_id,'created',v_actor_name,
    jsonb_build_object('substitute_teacher_name',v_substitute_name,'absent_teacher_name',v_absent_name,
      'weekday',v_weekday,'period',v_assignment.period,'assignment_date',v_date,
      'class_sections',v_assignment.class_sections,'subject',v_assignment.subject)
  );

  return jsonb_build_object('assignment_id',v_assignment.id,'status',v_assignment.status,
    'teacher_name',v_assignment.teacher_name,'absent_teacher_name',v_assignment.absent_teacher_name,
    'weekday',v_assignment.weekday,'period',v_assignment.period,'assignment_date',v_assignment.assignment_date);
end;
$function$;
