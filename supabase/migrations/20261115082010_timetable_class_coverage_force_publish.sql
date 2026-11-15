-- Preserve incomplete timetable days and allow an administrator to publish a
-- five-day weekly version with a recorded coverage warning report.
ALTER TABLE public.timetable_weekly_versions
  DROP CONSTRAINT IF EXISTS timetable_weekly_versions_expected_teacher_count_check;
ALTER TABLE public.timetable_weekly_versions
  ADD CONSTRAINT timetable_weekly_versions_expected_teacher_count_check
  CHECK (expected_teacher_count IS NULL OR (expected_teacher_count >= 0 AND expected_teacher_count <= 500));

CREATE OR REPLACE FUNCTION public.save_timetable_weekly_day(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_weekday text := p_payload->>'weekday';
  v_actor text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_version_id uuid := nullif(p_payload->>'version_id','')::uuid;
  v_version public.timetable_weekly_versions%rowtype;
  v_teacher jsonb;
  v_cell jsonb;
  v_source_name text;
  v_matched_name text;
  v_match_status text;
  v_page integer;
  v_cell_count integer := 0;
  v_teacher_count integer := 0;
  v_seen_periods integer[];
  v_existing_day_count integer := 0;
  v_period_count integer := coalesce(nullif(p_payload->>'period_count','')::integer,7);
begin
  if jsonb_typeof(p_payload) <> 'object'
    or v_weekday not in ('الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس')
    or v_actor = ''
    or jsonb_typeof(p_payload->'teachers') <> 'array'
    or jsonb_array_length(p_payload->'teachers') > 500
    or v_period_count not in (7,8) then
    raise exception 'بيانات اليوم أو قائمة المعلمين غير صالحة.';
  end if;

  perform pg_advisory_xact_lock(hashtext('timetable_weekly_versions'));
  if v_version_id is null then
    insert into public.timetable_weekly_versions(version,status,expected_teacher_count,period_count,created_by)
    values (
      coalesce((select max(version) from public.timetable_weekly_versions),0)+1,
      'draft',
      jsonb_array_length(p_payload->'teachers'),
      v_period_count,
      v_actor
    ) returning * into v_version;
    v_version_id := v_version.id;
  else
    select * into v_version from public.timetable_weekly_versions
      where id = v_version_id and status = 'draft' for update;
    if not found then raise exception 'نسخة الجدول غير موجودة أو ليست مسودة.'; end if;
    if v_version.period_count is distinct from v_period_count then
      raise exception 'عدد الحصص في هذا اليوم لا يطابق عدد الحصص في بقية أيام النسخة.';
    end if;
  end if;

  select count(*) into v_existing_day_count
    from public.timetable_weekly_audit
    where version_id = v_version_id and weekday = v_weekday
      and action in ('day_saved','day_replaced');

  -- Validate every supplied row before replacing the saved day. An empty array
  -- is valid: it records that the source day was reviewed but yielded no rows.
  for v_teacher in select value from jsonb_array_elements(p_payload->'teachers')
  loop
    v_source_name := left(btrim(coalesce(v_teacher->>'sourceName','')),200);
    v_matched_name := nullif(left(btrim(coalesce(v_teacher->>'matchedTeacherName','')),160),'');
    v_match_status := coalesce(v_teacher->>'matchStatus','unmatched');
    v_page := nullif(v_teacher->>'pdfPage','')::integer;
    if v_source_name = '' or v_match_status not in ('matched','unmatched','ambiguous')
      or jsonb_typeof(v_teacher->'cells') <> 'array'
      or jsonb_array_length(v_teacher->'cells') <> v_period_count then
      raise exception 'سجل معلم غير مكتمل أو لا يطابق عدد الحصص في النسخة.';
    end if;
    if (v_match_status = 'matched') <> (v_matched_name is not null) then
      raise exception 'حالة مطابقة اسم المعلم لا تتوافق مع الاسم المرتبط.';
    end if;
    if v_matched_name is not null and not exists (
      select 1 from public.teachers where name = v_matched_name and role = 'teacher'
    ) then
      raise exception 'المعلم المرتبط غير موجود في حسابات المعلمين: %', v_matched_name;
    end if;
    v_seen_periods := array[]::integer[];
    for v_cell in select value from jsonb_array_elements(v_teacher->'cells')
    loop
      if coalesce((v_cell->>'period')::integer,0) not between 1 and v_period_count
        or coalesce(v_cell->>'status','') not in ('teaching','free','meeting','activity','other','unclear')
        or jsonb_typeof(v_cell->'classSections') <> 'array'
        or not (v_cell ? 'sourceClass' and v_cell ? 'sourceSubject' and v_cell ? 'sourceStatus') then
        raise exception 'توجد خانة حصة غير مكتملة في سجل المعلم %.', v_source_name;
      end if;
      v_seen_periods := array_append(v_seen_periods,(v_cell->>'period')::integer);
    end loop;
    if (select count(distinct x) from unnest(v_seen_periods) x) <> v_period_count then
      raise exception 'يجب أن تكون جميع حصص النسخة دون تكرار للمعلم %.', v_source_name;
    end if;
    v_teacher_count := v_teacher_count + 1;
  end loop;

  delete from public.timetable_weekly_cells where version_id = v_version_id and weekday = v_weekday;

  for v_teacher in select value from jsonb_array_elements(p_payload->'teachers')
  loop
    v_source_name := left(btrim(v_teacher->>'sourceName'),200);
    v_matched_name := nullif(left(btrim(coalesce(v_teacher->>'matchedTeacherName','')),160),'');
    v_match_status := coalesce(v_teacher->>'matchStatus','unmatched');
    v_page := nullif(v_teacher->>'pdfPage','')::integer;
    for v_cell in select value from jsonb_array_elements(v_teacher->'cells')
    loop
      insert into public.timetable_weekly_cells(
        version_id,teacher_source_name,matched_teacher_name,match_status,weekday,period,cell_status,
        class_sections,subject,source_page,source_data
      ) values (
        v_version_id,v_source_name,v_matched_name,v_match_status,v_weekday,(v_cell->>'period')::integer,
        v_cell->>'status',v_cell->'classSections',left(coalesce(v_cell->>'subject',''),160),
        v_page,v_cell
      );
      v_cell_count := v_cell_count + 1;
    end loop;
  end loop;

  insert into public.timetable_weekly_audit(version_id,action,weekday,actor_name,before_data,after_data)
  values (
    v_version_id,
    case when v_existing_day_count > 0 then 'day_replaced' else 'day_saved' end,
    v_weekday,v_actor,
    case when v_existing_day_count > 0 then jsonb_build_object('previous_cell_count',v_existing_day_count) else null end,
    jsonb_build_object('teacher_count',v_teacher_count,'cell_count',v_cell_count)
  );

  return jsonb_build_object(
    'version_id',v_version_id,'version',v_version.version,'status','draft',
    'weekday',v_weekday,'teacher_count',v_teacher_count,'cell_count',v_cell_count
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.activate_timetable_weekly_version(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_version_id uuid := nullif(p_payload->>'version_id','')::uuid;
  v_actor text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_force boolean := coalesce((p_payload->>'force_with_warnings')::boolean,false);
  v_version public.timetable_weekly_versions%rowtype;
  v_teacher_count integer;
  v_cell_count integer;
  v_unmatched integer;
  v_incomplete integer;
  v_saved_days integer;
  v_period_count integer;
begin
  if v_version_id is null or v_actor = '' then raise exception 'بيانات اعتماد النسخة غير صالحة.'; end if;
  perform pg_advisory_xact_lock(hashtext('timetable_weekly_versions'));
  select * into v_version from public.timetable_weekly_versions
    where id = v_version_id and status = 'draft' for update;
  if not found then raise exception 'نسخة الجدول غير موجودة أو ليست مسودة.'; end if;
  v_period_count := v_version.period_count;

  select count(*),count(*) filter (where match_status <> 'matched')
    into v_cell_count,v_unmatched
    from public.timetable_weekly_cells where version_id = v_version_id;

  select count(distinct weekday) into v_saved_days
    from public.timetable_weekly_audit
    where version_id = v_version_id and action in ('day_saved','day_replaced');
  if v_saved_days <> 5 then
    raise exception 'لا يمكن اعتماد الجدول قبل حفظ الأيام الدراسية الخمسة.';
  end if;

  if not v_force then
    if v_unmatched > 0 then
      raise exception 'لا يمكن اعتماد الأسبوع قبل ربط جميع أسماء المعلمين بحساباتهم. توجد % خانات غير مرتبطة.',v_unmatched;
    end if;
    if v_cell_count <> coalesce(v_version.expected_teacher_count,0)*5*v_period_count then
      raise exception 'الجدول غير مكتمل: يجب أن يحتوي كل معلم على عدد الخانات المحدد في النسخة (خمسة أيام × عدد الحصص).';
    end if;
    select count(*) into v_incomplete
    from (
      select matched_teacher_name
      from public.timetable_weekly_cells
      where version_id=v_version_id
      group by matched_teacher_name
      having count(*) <> 5*v_period_count
        or count(distinct weekday) <> 5
        or count(distinct period) <> v_period_count
    ) incomplete_teachers;
    if v_incomplete > 0 then raise exception 'يوجد % معلم لم يكتمل جدوله الأسبوعي.',v_incomplete; end if;
  end if;

  select count(distinct matched_teacher_name) into v_teacher_count
    from public.timetable_weekly_cells where version_id=v_version_id and matched_teacher_name is not null;

  update public.timetable_weekly_versions set status='superseded',updated_at=now() where status='active';
  update public.timetable_weekly_versions set status='active',activated_by=v_actor,activated_at=now(),updated_at=now()
    where id=v_version_id;
  insert into public.timetable_weekly_audit(version_id,action,actor_name,after_data)
  values(v_version_id,'version_activated',v_actor,jsonb_build_object(
    'teacher_count',v_teacher_count,'cell_count',v_cell_count,'period_count',v_period_count,
    'force_with_warnings',v_force,'warnings',coalesce(p_payload->'warnings','{}'::jsonb)
  ));
  return jsonb_build_object(
    'version_id',v_version_id,'status','active','teacher_count',v_teacher_count,
    'cell_count',v_cell_count,'period_count',v_period_count,'force_with_warnings',v_force,
    'warnings',coalesce(p_payload->'warnings','{}'::jsonb)
  );
end;
$function$;
