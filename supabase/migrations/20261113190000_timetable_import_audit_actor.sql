-- Keep the actual authenticated timetable principal type in the audit trail.
-- Additive, development-only change; no timetable or account rows are modified.
alter table public.timetable_import_audit
  drop constraint if exists timetable_import_audit_actor_type_check;
alter table public.timetable_import_audit
  add constraint timetable_import_audit_actor_type_check
  check (actor_type in ('admin','teacher','custom'));

create or replace function public.mutate_timetable_import_record(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_mode text := coalesce(p_payload->>'mode','');
  v_import_id uuid := (p_payload->>'import_id')::uuid;
  v_record_id uuid := nullif(p_payload->>'record_id','')::uuid;
  v_actor text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_record public.timetable_import_records%rowtype;
  v_teacher_id uuid;
  v_teacher_name text;
  v_record_data jsonb := p_payload->'record_data';
  v_weekday text;
  v_period integer;
  v_class text;
  v_group text;
  v_room text;
  v_source_row integer;
begin
  if v_import_id is null or v_actor = '' or v_actor_type not in ('admin','teacher','custom') or v_mode not in ('add','update','delete') then
    raise exception 'Invalid timetable record mutation';
  end if;

  perform 1 from public.timetable_imports
    where id = v_import_id and status = 'draft'
    for update;
  if not found then raise exception 'لا يمكن تعديل هذه النسخة؛ يجب أن تكون مسودة.'; end if;

  if v_mode in ('update','delete') then
    select * into v_record
      from public.timetable_import_records
      where id = v_record_id and import_id = v_import_id
      for update;
    if not found then raise exception 'سجل الحصة المطلوب غير موجود.'; end if;
  end if;

  if v_mode = 'delete' then
    insert into public.timetable_import_audit (
      import_id, record_id, action, actor_type, actor_name, before_data
    ) values (
      v_import_id, v_record.id, 'record_deleted', v_actor_type, v_actor, v_record.record_data
    );
    delete from public.timetable_import_records where id = v_record.id;
    update public.timetable_imports
       set has_weekly_placements = exists (
         select 1 from public.timetable_import_records
          where import_id = v_import_id and weekday is not null and period is not null
       ), updated_at = now()
     where id = v_import_id;
    return jsonb_build_object('ok',true,'mode','delete','record_id',v_record.id);
  end if;

  if jsonb_typeof(v_record_data) <> 'object' then
    raise exception 'بيانات الحصة غير صالحة.';
  end if;

  v_teacher_name := left(btrim(coalesce(v_record_data->>'teacherSourceName','')),200);
  if v_teacher_name = '' then raise exception 'يجب تحديد المعلم للحصة.'; end if;

  select count(*) into v_source_row
    from public.timetable_import_teachers t
   where t.import_id = v_import_id
     and t.match_status <> 'ambiguous'
     and lower(t.source_name) = lower(v_teacher_name);
  if v_source_row = 1 then
    select t.id into v_teacher_id
      from public.timetable_import_teachers t
     where t.import_id = v_import_id
       and t.match_status <> 'ambiguous'
       and lower(t.source_name) = lower(v_teacher_name)
     limit 1;
  elsif v_source_row > 1 then
    raise exception 'اسم المعلم غير مطابق أو ملتبس ضمن هذه النسخة.';
  else
    select count(*) into v_source_row
      from public.timetable_import_teachers t
     where t.import_id = v_import_id
       and t.match_status <> 'ambiguous'
       and exists (
         select 1 from jsonb_array_elements_text(t.aliases) alias(value)
          where lower(alias.value) = lower(v_teacher_name)
       );
    if coalesce(v_source_row,0) <> 1 then
      raise exception 'اسم المعلم غير مطابق أو ملتبس ضمن هذه النسخة.';
    end if;
    select t.id into v_teacher_id
      from public.timetable_import_teachers t
     where t.import_id = v_import_id
       and t.match_status <> 'ambiguous'
       and exists (
         select 1 from jsonb_array_elements_text(t.aliases) alias(value)
          where lower(alias.value) = lower(v_teacher_name)
       )
     limit 1;
  end if;

  v_weekday := nullif(btrim(coalesce(v_record_data->>'weekday','')),'');
  v_period := nullif(v_record_data->>'period','')::integer;
  if (v_weekday is null) <> (v_period is null) then
    raise exception 'يجب إدخال اليوم ورقم الحصة معاً أو تركهما فارغين معاً.';
  end if;
  if v_period is not null and v_period not between 1 and 20 then
    raise exception 'رقم الحصة خارج النطاق المسموح.';
  end if;
  if v_weekday is not null and v_weekday not in ('الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس') then
    raise exception 'يوم الدراسة غير صالح.';
  end if;

  v_class := nullif(btrim(coalesce(v_record_data->>'className','')),'');
  v_group := nullif(btrim(coalesce(v_record_data->>'groupName','')),'');
  v_room := nullif(btrim(coalesce(v_record_data->>'rooms','')),'');
  if v_class is null or btrim(coalesce(v_record_data->>'subject','')) = '' then
    raise exception 'يجب تحديد الشعبة والمادة للحصة.';
  end if;

  if v_weekday is not null then
    if exists (
      select 1 from public.timetable_import_records r
       where r.import_id = v_import_id
         and r.id is distinct from v_record_id
         and r.weekday = v_weekday and r.period = v_period
         and r.import_teacher_id = v_teacher_id
    ) then raise exception 'تعارض: المعلم لديه حصة أخرى في اليوم والفترة نفسيهما.'; end if;

    if v_class is not null and exists (
      select 1 from public.timetable_import_records r
       where r.import_id = v_import_id
         and r.id is distinct from v_record_id
         and r.weekday = v_weekday and r.period = v_period
         and lower(coalesce(r.record_data->>'className','')) = lower(v_class)
         and (
           lower(coalesce(r.record_data->>'groupName','')) = lower(coalesce(v_group,''))
           or lower(coalesce(r.record_data->>'groupName','')) = 'الفصل بالكامل'
           or lower(coalesce(v_group,'')) = 'الفصل بالكامل'
         )
    ) then raise exception 'تعارض: الشعبة أو مجموعتها مرتبطة بحصة أخرى في الفترة نفسها.'; end if;

    if v_room is not null and exists (
      select 1 from public.timetable_import_records r
       where r.import_id = v_import_id
         and r.id is distinct from v_record_id
         and r.weekday = v_weekday and r.period = v_period
         and lower(coalesce(r.record_data->>'rooms','')) = lower(v_room)
    ) then raise exception 'تعارض: الغرفة محجوزة في اليوم والفترة نفسيهما.'; end if;
  end if;

  if v_mode = 'update' then
    update public.timetable_import_records
       set import_teacher_id = v_teacher_id,
           teacher_source_name = v_teacher_name,
           record_data = v_record_data,
           weekday = v_weekday,
           period = v_period,
           origin = 'manual',
           modified_by = v_actor,
           modified_at = now(),
           updated_at = now()
     where id = v_record.id;
    insert into public.timetable_import_audit (
      import_id, record_id, action, actor_type, actor_name, before_data, after_data
    ) values (
      v_import_id, v_record.id, 'record_updated', v_actor_type, v_actor, v_record.record_data, v_record_data
    );
    update public.timetable_imports
       set has_weekly_placements = exists (
         select 1 from public.timetable_import_records
          where import_id = v_import_id and weekday is not null and period is not null
       ), updated_at = now()
     where id = v_import_id;
    return jsonb_build_object('ok',true,'mode','update','record_id',v_record.id);
  end if;

  select coalesce(max(source_row),0) + 1 into v_source_row
    from public.timetable_import_records
   where import_id = v_import_id and source_sheet = 'manual';
  insert into public.timetable_import_records (
    import_id, import_teacher_id, teacher_source_name, source_sheet,
    source_row, origin, source_data, record_data, weekday, period,
    modified_by, modified_at
  ) values (
    v_import_id, v_teacher_id, v_teacher_name, 'manual',
    v_source_row, 'manual', null, v_record_data, v_weekday, v_period,
    v_actor, now()
  ) returning * into v_record;
  insert into public.timetable_import_audit (
    import_id, record_id, action, actor_type, actor_name, after_data
  ) values (
    v_import_id, v_record.id, 'record_added', v_actor_type, v_actor, v_record_data
  );
  update public.timetable_imports
     set has_weekly_placements = exists (
       select 1 from public.timetable_import_records
        where import_id = v_import_id and weekday is not null and period is not null
     ), updated_at = now()
   where id = v_import_id;
  return jsonb_build_object('ok',true,'mode','add','record_id',v_record.id);
end;
$function$;

create or replace function public.reassign_timetable_import_owner(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_import_id uuid := nullif(p_payload->>'import_id','')::uuid;
  v_source_name text := left(btrim(coalesce(p_payload->>'source_name','')),200);
  v_teacher_name text := left(btrim(coalesce(p_payload->>'teacher_name','')),200);
  v_actor text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_import_teacher public.timetable_import_teachers%rowtype;
  v_target record;
  v_old_owner text;
  v_old_status text;
  v_source_count integer;
begin
  if v_import_id is null or v_source_name = '' or v_actor = '' or v_actor_type not in ('admin','teacher','custom') then
    raise exception 'بيانات تبديل مالك الجدول غير مكتملة.';
  end if;

  perform 1 from public.timetable_imports
   where id = v_import_id and status = 'draft'
   for update;
  if not found then raise exception 'يمكن تبديل مالك الجدول في النسخة المسودة فقط.'; end if;

  select count(*) into v_source_count
    from public.timetable_import_teachers
   where import_id = v_import_id and source_name = v_source_name;
  if v_source_count = 0 then raise exception 'اسم المصدر غير موجود في نسخة الجدول.'; end if;
  if v_source_count > 1 then raise exception 'اسم المصدر مكرر ولا يمكن تبديل مالكه قبل معالجة التكرار.'; end if;

  select * into v_import_teacher
    from public.timetable_import_teachers
   where import_id = v_import_id and source_name = v_source_name
   for update;

  v_old_owner := v_import_teacher.matched_teacher_name;
  v_old_status := v_import_teacher.match_status;

  if v_teacher_name = '' then
    update public.timetable_import_teachers
       set matched_teacher_name = null,
           matched_department_id = null,
           matched_department_name = null,
           match_status = 'unmatched'
     where id = v_import_teacher.id;
  else
    select name, permissions into v_target
      from public.teachers
     where name = v_teacher_name and role = 'teacher';
    if not found then raise exception 'المعلم المختار غير موجود ضمن قائمة المعلمين في النظام.'; end if;

    update public.timetable_import_teachers
       set matched_teacher_name = v_target.name,
           matched_department_id = coalesce(v_target.permissions->>'category',v_target.permissions->>'department_id'),
           matched_department_name = coalesce(v_target.permissions->>'category',v_target.permissions->>'department_name',v_target.permissions->>'department_id'),
           match_status = 'matched'
     where id = v_import_teacher.id;
  end if;

  insert into public.timetable_import_audit (
    import_id, action, actor_type, actor_name, before_data, after_data
  ) values (
    v_import_id, 'owner_reassigned', v_actor_type, v_actor,
    jsonb_build_object('source_name',v_source_name,'owner',v_old_owner,'match_status',v_old_status),
    jsonb_build_object('source_name',v_source_name,'owner',nullif(v_teacher_name,''),'match_status',case when v_teacher_name='' then 'unmatched' else 'matched' end)
  );

  return jsonb_build_object('ok',true,'source_name',v_source_name,'matched_teacher_name',nullif(v_teacher_name,''));
end;
$function$;
