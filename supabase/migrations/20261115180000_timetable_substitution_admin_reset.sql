alter table public.timetable_assignment_audit
  drop constraint if exists timetable_assignment_audit_action_check;
alter table public.timetable_assignment_audit
  add constraint timetable_assignment_audit_action_check
  check (action = any (array[
    'created'::text,
    'cancelled'::text,
    'admin_reset_subject_day'::text,
    'department_reset_subject_day'::text,
    'admin_reset_all'::text
  ]));

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
  v_actor_department_id text := '';
  v_actor_permissions jsonb := '{}'::jsonb;
  v_subject_in_department boolean := false;
  v_count integer := 0;
begin
  if v_actor_name = '' then
    raise exception 'تعذر تحديد هوية منفذ العملية.';
  end if;

  if v_actor_type = 'admin' then
    if v_actor_name <> 'مدير النظام العام' then
      raise exception 'إعادة الضبط الشامل متاحة لمدير النظام العام فقط.';
    end if;
  elsif v_actor_type = 'teacher' then
    if v_mode <> 'subject_day' then
      raise exception 'منسق المادة يستطيع إلغاء احتياط مادته في يوم محدد فقط.';
    end if;
    select coalesce(permissions, '{}'::jsonb)
      into v_actor_permissions
      from public.teachers
     where name = v_actor_name and role = 'teacher'
     for share;
    if not found or coalesce(v_actor_permissions->>'reserve','false') <> 'true' then
      raise exception 'لا تملك صلاحية إدارة احتياط المادة.';
    end if;
    v_actor_department_id := coalesce(
      nullif(btrim(v_actor_permissions->>'category'),''),
      nullif(btrim(v_actor_permissions->>'department_id'),''),
      nullif(btrim(v_actor_permissions->>'department_name'),''),
      ''
    );
    if v_actor_department_id = '' then
      raise exception 'حسابك غير مرتبط بقسم محدد.';
    end if;
  else
    raise exception 'هذه العملية غير متاحة لهذا النوع من الحسابات.';
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
    if v_actor_type = 'teacher' then
      select exists (
        select 1
          from public.timetable_weekly_cells c
          join public.timetable_weekly_versions w on w.id = c.version_id and w.status = 'active'
          join public.teachers t on t.name = c.matched_teacher_name and t.role = 'teacher'
         where btrim(coalesce(c.subject,'')) = v_subject
           and coalesce(
             nullif(btrim(t.permissions->>'category'),''),
             nullif(btrim(t.permissions->>'department_id'),''),
             nullif(btrim(t.permissions->>'department_name'),''),
             ''
           ) = v_actor_department_id
      ) into v_subject_in_department;
      if not v_subject_in_department then
        raise exception 'لا يمكنك إلغاء سجلات مادة خارج قسمك.';
      end if;
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
           case when v_mode = 'all_active' then 'admin_reset_all'
                when v_actor_type = 'teacher' then 'department_reset_subject_day'
                else 'admin_reset_subject_day' end,
           v_actor_name,
           jsonb_build_object(
             'teacher_name',c.teacher_name,'absent_teacher_name',c.absent_teacher_name,
             'weekday',c.weekday,'period',c.period,'assignment_date',c.assignment_date,
             'subject',c.subject,'status',t.status
           ),
           jsonb_build_object('status','cancelled','reset_mode',v_mode)
      from changed c
      join targets t on t.id=c.id
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
