-- Reserve points rules: 14-hour deletion window, forced reversal on replacement/reset, and emergency triple-period bonus.

-- The existing ledger and event types are reused; no data is deleted and no permissions are changed.

create or replace function public.record_timetable_substitution_points()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_assignment public.timetable_assignments%rowtype;
  v_points integer;
  v_coverage_event_exists boolean := false;
  v_absence_event_exists boolean := false;
  v_reverse_points boolean := false;
  v_prior_teaching_periods integer := 0;
  v_bonus_net integer := 0;
  v_reason_normalized text := '';
  v_is_emergency boolean := false;
begin
  -- Create the normal points once. The follow-up UPDATE that saves reserve_reason
  -- re-enters this branch safely because the ledger event keys are idempotent.
  if TG_OP='INSERT' or (TG_OP='UPDATE' and NEW.status in ('assigned','confirmed','completed')) then
    v_assignment:=NEW;
    if v_assignment.assignment_type='substitution'
      and v_assignment.status in ('assigned','confirmed','completed') then
      v_points:=public.timetable_substitution_period_points(v_assignment.period);
      if v_points>0 then
        insert into public.timetable_substitution_points_ledger(
          assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name
        ) values (
          v_assignment.id,v_assignment.teacher_name,
          'assignment:'||v_assignment.id::text||':coverage',
          'coverage_credit',v_points,v_assignment.period,v_assignment.weekday,
          v_assignment.assignment_date,v_assignment.absent_teacher_name
        ) on conflict(event_key) do nothing;

        if nullif(btrim(coalesce(v_assignment.absent_teacher_name,'')),'') is not null then
          insert into public.timetable_substitution_points_ledger(
            assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name
          ) values (
            v_assignment.id,v_assignment.absent_teacher_name,
            'assignment:'||v_assignment.id::text||':absence',
            'absence_debit',-v_points,v_assignment.period,v_assignment.weekday,
            v_assignment.assignment_date,v_assignment.absent_teacher_name
          ) on conflict(event_key) do nothing;
        end if;

        -- Emergency is an explicit reason marker. Only the two immediately
        -- preceding timetable periods count, and both must be teaching periods.
        v_reason_normalized:=regexp_replace(
          translate(lower(coalesce(v_assignment.reserve_reason,'')),'أإآٱىة','اااايه'),
          '[[:space:]ـ]+','','g'
        );
        v_is_emergency:=(
          position('اضطرار' in v_reason_normalized)>0
          and v_reason_normalized !~ '(غير|ليس|مو).*اضطرار'
        ) or position('emergency' in lower(coalesce(v_assignment.reserve_reason,'')))>0;

        if v_is_emergency and v_assignment.period>=3 then
          select count(distinct c.period) into v_prior_teaching_periods
          from public.timetable_weekly_cells c
          where c.version_id=v_assignment.version_id
            and c.matched_teacher_name=v_assignment.teacher_name
            and c.weekday=v_assignment.weekday
            and c.period in (v_assignment.period-2,v_assignment.period-1)
            and c.cell_status='teaching';
        else
          v_prior_teaching_periods:=0;
        end if;

        select coalesce(sum(points_delta),0) into v_bonus_net
        from public.timetable_substitution_points_ledger
        where assignment_id=v_assignment.id
          and event_key like 'assignment:'||v_assignment.id::text||':emergency-bonus:%';

        if v_is_emergency and v_prior_teaching_periods=2 then
          if v_bonus_net<2 then
            insert into public.timetable_substitution_points_ledger(
              assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name
            ) values (
              v_assignment.id,v_assignment.teacher_name,
              'assignment:'||v_assignment.id::text||':emergency-bonus:credit:'||gen_random_uuid()::text,
              'coverage_credit',2-v_bonus_net,v_assignment.period,v_assignment.weekday,
              v_assignment.assignment_date,v_assignment.absent_teacher_name
            );
          end if;
        elsif v_bonus_net>0 then
          -- If the reason is edited and no longer says emergency, remove only
          -- the extra bonus; the normal period points remain unchanged.
          insert into public.timetable_substitution_points_ledger(
            assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name
          ) values (
            v_assignment.id,v_assignment.teacher_name,
            'assignment:'||v_assignment.id::text||':emergency-bonus:reason-reversal:'||gen_random_uuid()::text,
            'coverage_reversal',-v_bonus_net,v_assignment.period,v_assignment.weekday,
            v_assignment.assignment_date,v_assignment.absent_teacher_name
          );
        end if;
      end if;
    end if;
  end if;

  -- A normal deletion is reversible only during the first 14 hours from the
  -- original reserve approval. Replacements and explicit admin resets set
  -- the transaction-local force flag and always reverse the old assignment.
  if TG_OP='UPDATE'
    and OLD.assignment_type='substitution'
    and OLD.status in ('assigned','confirmed','completed')
    and NEW.status='cancelled' then
    v_reverse_points:=coalesce(current_setting('app.force_substitution_points_reversal',true),'false')='true'
      or coalesce(OLD.reserve_created_at,OLD.created_at)>=now()-interval '14 hours';

    if v_reverse_points then
      v_points:=public.timetable_substitution_period_points(OLD.period);
      if v_points>0 then
        select exists(
          select 1 from public.timetable_substitution_points_ledger
          where assignment_id=OLD.id
            and event_key='assignment:'||OLD.id::text||':coverage'
        ) into v_coverage_event_exists;

        if v_coverage_event_exists then
          insert into public.timetable_substitution_points_ledger(
            assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name
          ) values (
            OLD.id,OLD.teacher_name,
            'assignment:'||OLD.id::text||':coverage-reversal',
            'coverage_reversal',-v_points,OLD.period,OLD.weekday,
            OLD.assignment_date,OLD.absent_teacher_name
          ) on conflict(event_key) do nothing;
        end if;

        if nullif(btrim(coalesce(OLD.absent_teacher_name,'')),'') is not null then
          select exists(
            select 1 from public.timetable_substitution_points_ledger
            where assignment_id=OLD.id
              and event_key='assignment:'||OLD.id::text||':absence'
          ) into v_absence_event_exists;

          if v_absence_event_exists then
            insert into public.timetable_substitution_points_ledger(
              assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name
            ) values (
              OLD.id,OLD.absent_teacher_name,
              'assignment:'||OLD.id::text||':absence-reversal',
              'absence_reversal',v_points,OLD.period,OLD.weekday,
              OLD.assignment_date,OLD.absent_teacher_name
            ) on conflict(event_key) do nothing;
          end if;
        end if;

        select coalesce(sum(points_delta),0) into v_bonus_net
        from public.timetable_substitution_points_ledger
        where assignment_id=OLD.id
          and event_key like 'assignment:'||OLD.id::text||':emergency-bonus:%';

        if v_bonus_net>0 then
          insert into public.timetable_substitution_points_ledger(
            assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name
          ) values (
            OLD.id,OLD.teacher_name,
            'assignment:'||OLD.id::text||':emergency-bonus:cancel-reversal:'||gen_random_uuid()::text,
            'coverage_reversal',-v_bonus_net,OLD.period,OLD.weekday,
            OLD.assignment_date,OLD.absent_teacher_name
          );
        end if;
      end if;
    end if;
  end if;

  return case when TG_OP='DELETE' then OLD else NEW end;
end;
$function$;

revoke all on function public.record_timetable_substitution_points() from public,anon,authenticated;
grant execute on function public.record_timetable_substitution_points() to service_role;


create or replace function public.cancel_timetable_substitution(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
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
  if v_assignment.status not in ('assigned','confirmed') then
    raise exception 'لا يمكن إلغاء تكليف مكتمل أو غير نشط.';
  end if;

  if v_assignment.assignment_date is distinct from (now() at time zone 'Asia/Muscat')::date then
    raise exception 'يمكن تعديل أو حذف سجل الاحتياط خلال يومه فقط، وحتى نهاية اليوم بتوقيت سلطنة عمان.';
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

create or replace function public.replace_timetable_substitution_with_reason(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
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
  if v_old.assignment_date is distinct from (now() at time zone 'Asia/Muscat')::date then
    raise exception 'يمكن تعديل سجل الاحتياط خلال يومه فقط، وحتى نهاية اليوم بتوقيت سلطنة عمان.';
  end if;
  v_period:=coalesce(nullif(p_payload->>'period','')::integer,v_old.period::integer);
  if v_period not between 1 and 8 then raise exception 'رقم الحصة المحدد غير صالح.'; end if;

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
  if v_old.assignment_date is distinct from (now() at time zone 'Asia/Muscat')::date then
    raise exception 'يمكن تعديل سجل الاحتياط خلال يومه فقط، وحتى نهاية اليوم بتوقيت سلطنة عمان.';
  end if;
  v_period:=coalesce(nullif(p_payload->>'period','')::integer,v_old.period::integer);
  if v_period not between 1 and 8 then raise exception 'رقم الحصة المحدد غير صالح.'; end if;

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

  perform set_config('app.force_substitution_points_reversal','true',true);

  with targets as (
    select id, version_id, teacher_name, absent_teacher_name, weekday, period,
           assignment_date, subject, status
    from public.timetable_assignments
    where assignment_type = 'substitution'
      and status in ('assigned','confirmed')
      and (
        v_mode = 'all_active'
        or (
          assignment_date = v_date
          and btrim(coalesce(subject,'')) = v_subject
          and (
            v_actor_type = 'admin'
            or exists (
              select 1
                from public.teachers absent
               where absent.name = public.timetable_assignments.absent_teacher_name
                 and absent.role = 'teacher'
                 and coalesce(
                   nullif(btrim(absent.permissions->>'category'),''),
                   nullif(btrim(absent.permissions->>'department_id'),''),
                   nullif(btrim(absent.permissions->>'department_name'),''),
                   ''
                 ) = v_actor_department_id
            )
          )
        )
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
  perform set_config('app.force_substitution_points_reversal','false',true);

  return jsonb_build_object(
    'ok', true,
    'mode', v_mode,
    'cancelled_count', v_count,
    'assignment_date', case when v_mode = 'subject_day' then v_date::text else null end,
    'subject', case when v_mode = 'subject_day' then v_subject else null end
  );
end;
$function$;

revoke all on function public.cancel_timetable_substitution(jsonb) from public,anon,authenticated;

revoke all on function public.replace_timetable_substitution_with_reason(jsonb) from public,anon,authenticated;

revoke all on function public.reassign_timetable_substitution_absent_with_reason(jsonb) from public,anon,authenticated;

revoke all on function public.reset_timetable_substitution_records(jsonb) from public,anon,authenticated;

grant execute on function public.cancel_timetable_substitution(jsonb) to service_role;

grant execute on function public.replace_timetable_substitution_with_reason(jsonb) to service_role;

grant execute on function public.reassign_timetable_substitution_absent_with_reason(jsonb) to service_role;

grant execute on function public.reset_timetable_substitution_records(jsonb) to service_role;