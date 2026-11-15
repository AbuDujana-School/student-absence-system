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
  v_cell_weekdays integer;
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
  select count(distinct weekday) into v_cell_weekdays
    from public.timetable_weekly_cells where version_id = v_version_id;
  -- Normal imports prove all five days through day-save audit rows. A manually
  -- corrected clone may instead prove the full week through its copied cells.
  if v_saved_days <> 5 and v_cell_weekdays <> 5 then
    raise exception 'لا يمكن اعتماد الجدول قبل حفظ أو استنساخ الأيام الدراسية الخمسة.';
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
