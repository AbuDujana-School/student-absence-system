create or replace function public.reset_timetable_substitution_records(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_mode text := coalesce(p_payload->>'mode','');
  v_date date;
  v_subject text := left(btrim(coalesce(p_payload->>'subject','')),160);
  v_count integer := 0;
begin
  if v_actor_type <> 'admin' or v_actor_name = ' ' or v_actor_name = '' then
    raise exception 'تفريغ سجلات الاحتياط متاح لمدير النظام العام فقط.';
  end if;

  if v_mode = 'subject_day' then
    begin
      v_date := nullif(p_payload->>'assignment_date','')::date;
    exception when others then
      raise exception 'تاريخ تفريغ الاحتياط غير صالح.';
    end;
    if v_date is null or v_subject = '' then
      raise exception 'يجب تحديد التاريخ والمادة لتفريغ الاحتياط.';
    end if;
  elsif v_mode <> 'all_active' then
    raise exception 'نوع تفريغ سجلات الاحتياط غير صالح.';
  end if;

  with targets as (
    select id, version_id, teacher_name, absent_teacher_name, weekday, period,
           assignment_date, subject, status
    from public.timetable_assignments
    where assignment_type = 'substitution'
      and status in ('assigned','confirmed')
      and (
        v_mode = 'all_active'
        or (assignment_date = v_date and btrim(coalesce(subject,'')) = v_subject)
      )
    for update
  ), changed as (
    update public.timetable_assignments a
       set status = 'cancelled', updated_at = now()
      from targets t
     where a.id = t.id
    returning a.id, a.version_id, a.teacher_name, a.absent_teacher_name,
              a.weekday, a.period, a.assignment_date, a.subject, a.status
  ), audited as (
    insert into public.timetable_assignment_audit(
      assignment_id, version_id, action, actor_name, before_data, after_data
    )
    select c.id, c.version_id,
           case when v_mode = 'all_active' then 'admin_reset_all' else 'admin_reset_subject_day' end,
           v_actor_name,
           jsonb_build_object(
             'teacher_name',c.teacher_name,'absent_teacher_name',c.absent_teacher_name,
             'weekday',c.weekday,'period',c.period,'assignment_date',c.assignment_date,
             'subject',c.subject,'status','assigned_or_confirmed'
           ),
           jsonb_build_object('status','cancelled','reset_mode',v_mode)
      from changed c
    returning id
  )
  select count(*) into v_count from changed;

  return jsonb_build_object(
    'ok', true,
    'mode', v_mode,
    'cancelled_count', v_count,
    'assignment_date', case when v_mode = 'subject_day' then v_date::text else null end,
    'subject', case when v_mode = 'subject_day' then v_subject else null end
  );
end;
$function$;

revoke all on function public.reset_timetable_substitution_records(jsonb) from public, anon, authenticated;
grant execute on function public.reset_timetable_substitution_records(jsonb) to service_role;
