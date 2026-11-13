-- Atomic, server-only substitution assignment workflow.
-- Additive migration: never applied to the school's database from this session.

create table if not exists public.timetable_assignment_audit (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.timetable_assignments(id) on delete restrict,
  version_id uuid not null references public.timetable_weekly_versions(id) on delete restrict,
  action text not null check (action in ('created','cancelled')),
  actor_name text not null check (length(btrim(actor_name)) > 0),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists timetable_assignment_audit_version_idx
  on public.timetable_assignment_audit(version_id,created_at desc);
create unique index if not exists timetable_assignments_one_substitute_per_source_idx
  on public.timetable_assignments(source_cell_id)
  where assignment_type='substitution' and source_cell_id is not null and status in ('assigned','confirmed','completed');
alter table public.timetable_assignment_audit enable row level security;
revoke all on table public.timetable_assignment_audit from public,anon,authenticated;
grant all on table public.timetable_assignment_audit to service_role;

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
  v_absent_name text := left(btrim(coalesce(p_payload->>'absent_teacher_name','')),160);
  v_substitute_name text := left(btrim(coalesce(p_payload->>'substitute_teacher_name','')),160);
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_include_other boolean := coalesce((p_payload->>'include_other_departments')::boolean,false);
  v_active_id uuid;
  v_absent_cell public.timetable_weekly_cells%rowtype;
  v_candidate_cell public.timetable_weekly_cells%rowtype;
  v_absent_department text;
  v_candidate_department text;
  v_actor_department text;
  v_candidate_free_count integer;
  v_assignment public.timetable_assignments%rowtype;
begin
  if v_version_id is null or v_weekday not in ('الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس')
    or v_period not between 1 and 7 or v_absent_name='' or v_substitute_name=''
    or v_actor_name='' or v_actor_type not in ('admin','teacher','custom')
    or v_absent_name=v_substitute_name then
    raise exception 'بيانات تكليف الاحتياط غير مكتملة أو غير صالحة.';
  end if;

  perform pg_advisory_xact_lock(hashtext('timetable_substitution:'||v_version_id::text||':'||v_weekday||':'||v_period::text));
  select id into v_active_id from public.timetable_weekly_versions
    where id=v_version_id and status='active' for share;
  if v_active_id is null then raise exception 'الجدول المحدد ليس النسخة الأسبوعية النشطة.'; end if;

  select * into v_absent_cell from public.timetable_weekly_cells
    where version_id=v_version_id and matched_teacher_name=v_absent_name
      and weekday=v_weekday and period=v_period and cell_status='teaching';
  if not found then raise exception 'لا توجد حصة تدريس مسجلة للمعلم الغائب في هذه الفترة.'; end if;

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

  if not v_include_other and v_candidate_department is distinct from v_absent_department then
    raise exception 'المعلم المرشح من قسم آخر. فعّل خيار إظهار الأقسام الأخرى أولاً.';
  end if;

  select count(*) into v_candidate_free_count
    from public.timetable_weekly_cells
    where version_id=v_version_id and matched_teacher_name=v_substitute_name
      and weekday=v_weekday and period=(p_payload->>'period')::integer and cell_status='free';
  if v_candidate_free_count<>1 then raise exception 'المعلم المرشح ليس لديه فراغ مؤكد في هذه الحصة.'; end if;

  if exists (select 1 from public.timetable_assignments where source_cell_id=v_absent_cell.id
    and assignment_type='substitution' and status in ('assigned','confirmed','completed')) then
    raise exception 'تم تعيين بديل لهذه الحصة مسبقاً.';
  end if;

  if exists (
    select 1 from public.timetable_assignments
    where version_id=v_version_id and teacher_name=v_substitute_name
      and weekday=v_weekday and period=(p_payload->>'period')::integer
      and status in ('assigned','confirmed','completed')
  ) then raise exception 'المعلم المرشح لديه تكليف آخر في الحصة نفسها.'; end if;

  insert into public.timetable_assignments(
    version_id,teacher_name,assignment_type,weekday,period,class_sections,subject,
    absent_teacher_name,source_cell_id,status,created_by
  ) values (
    v_version_id,v_substitute_name,'substitution',v_weekday,(p_payload->>'period')::smallint,
    v_absent_cell.class_sections,v_absent_cell.subject,v_absent_name,v_absent_cell.id,'assigned',v_actor_name
  ) returning * into v_assignment;

  insert into public.timetable_assignment_audit(
    assignment_id,version_id,action,actor_name,after_data
  ) values (
    v_assignment.id,v_version_id,'created',v_actor_name,
    jsonb_build_object('substitute_teacher_name',v_substitute_name,'absent_teacher_name',v_absent_name,
      'weekday',v_weekday,'period',v_assignment.period,'class_sections',v_assignment.class_sections,'subject',v_assignment.subject)
  );

  return jsonb_build_object('assignment_id',v_assignment.id,'status',v_assignment.status,
    'teacher_name',v_assignment.teacher_name,'absent_teacher_name',v_assignment.absent_teacher_name,
    'weekday',v_assignment.weekday,'period',v_assignment.period);
end;
$function$;

revoke all on function public.create_timetable_substitution(jsonb) from public,anon,authenticated;
grant execute on function public.create_timetable_substitution(jsonb) to service_role;
