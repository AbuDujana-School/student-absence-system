-- Make manual class-vacancy assignment a single atomic database operation.
-- The caller uses the service role; direct client execution is revoked.
create or replace function public.assign_timetable_class_vacancy(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_class text := left(btrim(coalesce(p_payload->>'class_name','')),100);
  v_weekday text := p_payload->>'weekday';
  v_period integer := nullif(p_payload->>'period','')::integer;
  v_teacher text := left(btrim(coalesce(p_payload->>'teacher_name','')),160);
  v_subject text := left(btrim(coalesce(p_payload->>'subject','')),160);
  v_actor text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_requested_id uuid := nullif(p_payload->>'version_id','')::uuid;
  v_source public.timetable_weekly_versions%rowtype;
  v_target_id uuid;
  v_target_version integer;
  v_cell public.timetable_weekly_cells%rowtype;
begin
  if jsonb_typeof(p_payload) <> 'object'
    or v_class = '' or v_weekday not in ('الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس')
    or v_period is null or v_period not between 1 and 8
    or v_teacher = '' or v_subject = '' or v_actor = '' then
    raise exception 'بيانات إسناد الحصة غير مكتملة أو غير صالحة.';
  end if;

  perform pg_advisory_xact_lock(hashtext('timetable_class_vacancy_assign'));
  select * into v_source
  from public.timetable_weekly_versions
  where (v_requested_id is null and status='active') or id=v_requested_id
  for update;
  if not found or v_source.status not in ('active','draft') then
    raise exception 'النسخة المحددة غير موجودة أو لا تقبل التعديل.';
  end if;
  if v_period > coalesce(v_source.period_count,7) then
    raise exception 'رقم الحصة يتجاوز عدد حصص اليوم في هذه النسخة.';
  end if;
  if not exists (select 1 from public.teachers where name=v_teacher and role='teacher') then
    raise exception 'المعلم المحدد غير موجود في فهرس المعلمين.';
  end if;
  if not exists (
    select 1 from public.timetable_weekly_cells
    where version_id=v_source.id and class_sections @> jsonb_build_array(v_class)
  ) then
    raise exception 'الصف أو الشعبة غير موجود في جدول النسخة الحالية.';
  end if;
  if exists (
    select 1 from public.timetable_weekly_cells
    where version_id=v_source.id and weekday=v_weekday and period=v_period
      and class_sections @> jsonb_build_array(v_class)
  ) then
    raise exception 'الصف لديه تكليف مسجل بالفعل في هذه الحصة. راجع التعارضات أولاً.';
  end if;

  if v_source.status='active' then
    select coalesce(max(version),0)+1 into v_target_version
      from public.timetable_weekly_versions;
    insert into public.timetable_weekly_versions(
      version,status,expected_teacher_count,period_count,source_label,created_by
    ) values (
      v_target_version,'draft',v_source.expected_teacher_count,
      coalesce(v_source.period_count,7),
      'مراجعة يدوية للنسخة '||v_source.version,v_actor
    ) returning id into v_target_id;

    insert into public.timetable_weekly_cells(
      version_id,teacher_source_name,matched_teacher_name,match_status,weekday,period,
      cell_status,class_sections,subject,source_page,source_data
    )
    select v_target_id,teacher_source_name,matched_teacher_name,match_status,weekday,period,
      cell_status,class_sections,subject,source_page,source_data
    from public.timetable_weekly_cells where version_id=v_source.id;
  else
    v_target_id := v_source.id;
    v_target_version := v_source.version;
  end if;

  select * into v_cell
  from public.timetable_weekly_cells
  where version_id=v_target_id and matched_teacher_name=v_teacher
    and weekday=v_weekday and period=v_period
    and cell_status='free' and class_sections='[]'::jsonb
  for update;
  if not found then
    raise exception 'المعلم المحدد ليس لديه حصة فراغ متاحة في هذا الوقت. اختر معلماً آخر.';
  end if;

  update public.timetable_weekly_cells
  set cell_status='teaching',
      class_sections=jsonb_build_array(v_class),
      subject=v_subject,
      source_data=jsonb_build_object(
        'status','teaching','classSections',jsonb_build_array(v_class),
        'subject',v_subject,'sourceClass',v_class,'sourceSubject',v_subject,
        'sourceStatus','إسناد يدوي من جدول الصفوف',
        'sourceNote','إسناد يدوي بواسطة '||v_actor,'manualAssignment',true
      ),
      updated_at=now()
  where id=v_cell.id and version_id=v_target_id;

  insert into public.timetable_weekly_audit(
    version_id,action,weekday,actor_name,after_data
  ) values (
    v_target_id,'day_replaced',v_weekday,v_actor,
    jsonb_build_object(
      'action','class_vacancy_assigned','className',v_class,
      'teacherName',v_teacher,'subject',v_subject,'period',v_period
    )
  );

  return jsonb_build_object(
    'version_id',v_target_id,'version',v_target_version,
    'review_required',v_source.status='active','status','draft'
  );
end;
$function$;

revoke all on function public.assign_timetable_class_vacancy(jsonb) from public, anon, authenticated;
grant execute on function public.assign_timetable_class_vacancy(jsonb) to service_role;
