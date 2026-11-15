-- Weighted fairness ledger and atomic multi-absence substitution.
-- Additive only: existing school data and permission values are not modified.

create table if not exists public.timetable_substitution_points_ledger (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.timetable_assignments(id) on delete restrict,
  teacher_name text not null,
  event_key text not null unique,
  event_type text not null check (event_type in ('coverage_credit','absence_debit','coverage_reversal','absence_reversal')),
  points_delta integer not null check (points_delta <> 0),
  period smallint not null check (period between 1 and 8),
  weekday text not null check (weekday in ('الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس')),
  assignment_date date,
  absent_teacher_name text,
  created_at timestamptz not null default now()
);
create index if not exists timetable_substitution_points_teacher_idx
  on public.timetable_substitution_points_ledger(teacher_name,created_at desc);
create index if not exists timetable_substitution_points_date_idx
  on public.timetable_substitution_points_ledger(assignment_date,weekday);
alter table public.timetable_substitution_points_ledger enable row level security;
revoke all on table public.timetable_substitution_points_ledger from public,anon,authenticated;
grant all on table public.timetable_substitution_points_ledger to service_role;

create or replace function public.timetable_substitution_period_points(p_period integer)
returns integer language sql immutable parallel safe set search_path = pg_catalog
as $function$
  select case p_period when 1 then 1 when 2 then 1 when 3 then 2 when 4 then 2
    when 5 then 4 when 6 then 3 when 7 then 5 when 8 then 7 else 0 end;
$function$;
revoke all on function public.timetable_substitution_period_points(integer) from public,anon,authenticated;
grant execute on function public.timetable_substitution_period_points(integer) to service_role;

create or replace function public.record_timetable_substitution_points()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_assignment public.timetable_assignments%rowtype;
  v_points integer;
begin
  if TG_OP='INSERT' then
    v_assignment:=NEW;
    if v_assignment.assignment_type='substitution' and v_assignment.status in ('assigned','confirmed','completed') then
      v_points:=public.timetable_substitution_period_points(v_assignment.period);
      if v_points>0 then
        insert into public.timetable_substitution_points_ledger(assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name)
        values(v_assignment.id,v_assignment.teacher_name,'assignment:'||v_assignment.id::text||':coverage','coverage_credit',v_points,v_assignment.period,v_assignment.weekday,v_assignment.assignment_date,v_assignment.absent_teacher_name)
        on conflict(event_key) do nothing;
        if nullif(btrim(coalesce(v_assignment.absent_teacher_name,'')),'') is not null then
          insert into public.timetable_substitution_points_ledger(assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name)
          values(v_assignment.id,v_assignment.absent_teacher_name,'assignment:'||v_assignment.id::text||':absence','absence_debit',-v_points,v_assignment.period,v_assignment.weekday,v_assignment.assignment_date,v_assignment.absent_teacher_name)
          on conflict(event_key) do nothing;
        end if;
      end if;
    end if;
    return NEW;
  end if;
  if OLD.assignment_type='substitution' and OLD.status in ('assigned','confirmed','completed') and NEW.status='cancelled' then
    v_points:=public.timetable_substitution_period_points(OLD.period);
    if v_points>0 then
      insert into public.timetable_substitution_points_ledger(assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name)
      values(OLD.id,OLD.teacher_name,'assignment:'||OLD.id::text||':coverage-reversal','coverage_reversal',-v_points,OLD.period,OLD.weekday,OLD.assignment_date,OLD.absent_teacher_name)
      on conflict(event_key) do nothing;
      if nullif(btrim(coalesce(OLD.absent_teacher_name,'')),'') is not null then
        insert into public.timetable_substitution_points_ledger(assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name)
        values(OLD.id,OLD.absent_teacher_name,'assignment:'||OLD.id::text||':absence-reversal','absence_reversal',v_points,OLD.period,OLD.weekday,OLD.assignment_date,OLD.absent_teacher_name)
        on conflict(event_key) do nothing;
      end if;
    end if;
  end if;
  return NEW;
end;
$function$;
drop trigger if exists timetable_substitution_points_ledger_trigger on public.timetable_assignments;
create trigger timetable_substitution_points_ledger_trigger
after insert or update on public.timetable_assignments
for each row execute function public.record_timetable_substitution_points();
revoke all on function public.record_timetable_substitution_points() from public,anon,authenticated;
grant execute on function public.record_timetable_substitution_points() to service_role;

insert into public.timetable_substitution_points_ledger(assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name)
select a.id,a.teacher_name,'assignment:'||a.id::text||':coverage','coverage_credit',
  public.timetable_substitution_period_points(a.period),a.period,a.weekday,a.assignment_date,a.absent_teacher_name
from public.timetable_assignments a
where a.assignment_type='substitution' and a.status in ('assigned','confirmed','completed')
  and public.timetable_substitution_period_points(a.period)>0
on conflict(event_key) do nothing;
insert into public.timetable_substitution_points_ledger(assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name)
select a.id,a.absent_teacher_name,'assignment:'||a.id::text||':absence','absence_debit',
  -public.timetable_substitution_period_points(a.period),a.period,a.weekday,a.assignment_date,a.absent_teacher_name
from public.timetable_assignments a
where a.assignment_type='substitution' and a.status in ('assigned','confirmed','completed')
  and nullif(btrim(coalesce(a.absent_teacher_name,'')),'') is not null
  and public.timetable_substitution_period_points(a.period)>0
on conflict(event_key) do nothing;

create or replace function public.create_timetable_substitution(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
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
  v_candidate_free_count integer;
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
    select coalesce(permissions->>'category',permissions->>'department_id',permissions->>'department_name','')
      into v_actor_department from public.teachers where name=v_actor_name and role in ('teacher','custom');
    if not found or v_actor_department='' or v_absent_department='' or v_actor_department<>v_absent_department then
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

create or replace function public.create_timetable_substitution_batch(p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp
as $function$
declare
  v_version_id uuid := nullif(p_payload->>'version_id','')::uuid;
  v_weekday text := p_payload->>'weekday';
  v_date date := nullif(p_payload->>'assignment_date','')::date;
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_include_other boolean := coalesce((p_payload->>'include_other_departments')::boolean,false);
  v_absent_names jsonb := p_payload->'absent_teacher_names';
  v_items jsonb := p_payload->'assignments';
  v_item jsonb;
  v_absent_name text;
  v_substitute_name text;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if v_version_id is null or v_date is null
    or v_weekday not in ('الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس')
    or v_weekday is distinct from (case extract(dow from v_date)
      when 0 then 'الأحد' when 1 then 'الاثنين' when 2 then 'الثلاثاء'
      when 3 then 'الأربعاء' when 4 then 'الخميس' else 'خارج أيام الدراسة' end)
    or v_actor_name='' or v_actor_type not in ('admin','teacher','custom')
    or coalesce(jsonb_typeof(v_absent_names),'')<>'array' or jsonb_array_length(v_absent_names)<1
    or jsonb_array_length(v_absent_names)>100
    or coalesce(jsonb_typeof(v_items),'')<>'array' or jsonb_array_length(v_items)<1
    or jsonb_array_length(v_items)>500 then
    raise exception 'بيانات التوزيع الجماعي غير مكتملة أو غير صالحة.';
  end if;
  if (select count(distinct value) from jsonb_array_elements_text(v_absent_names))<>jsonb_array_length(v_absent_names) then
    raise exception 'توجد أسماء معلمين غائبين مكررة في القائمة.';
  end if;
  for v_item in select value from jsonb_array_elements(v_items)
  loop
    v_absent_name:=left(btrim(coalesce(v_item->>'absentTeacherName','')),160);
    v_substitute_name:=left(btrim(coalesce(v_item->>'substituteTeacherName','')),160);
    if v_absent_name='' or v_substitute_name='' or not (v_absent_names ? v_absent_name) then
      raise exception 'كل حصة يجب أن ترتبط بأحد المعلمين الغائبين المحددين.';
    end if;
    v_result:=public.create_timetable_substitution(jsonb_build_object(
      'version_id',v_version_id,'weekday',v_weekday,'period',v_item->>'period',
      'assignment_date',v_date,'absent_teacher_name',v_absent_name,
      'substitute_teacher_name',v_substitute_name,'actor_name',v_actor_name,
      'actor_type',v_actor_type,'include_other_departments',v_include_other
    ));
    v_results:=v_results||jsonb_build_array(v_result);
    v_count:=v_count+1;
  end loop;
  return jsonb_build_object('created_count',v_count,'assignments',v_results,'atomic',true);
end;
$function$;
revoke all on function public.create_timetable_substitution_batch(jsonb) from public,anon,authenticated;
grant execute on function public.create_timetable_substitution_batch(jsonb) to service_role;
