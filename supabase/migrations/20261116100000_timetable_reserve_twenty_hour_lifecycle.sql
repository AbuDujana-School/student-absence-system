-- Keep the original creation time across reserve edits and enforce a strict 20-hour edit window.
alter table public.timetable_assignments
  add column if not exists reserve_created_at timestamptz;

update public.timetable_assignments
set reserve_created_at = created_at
where assignment_type = 'substitution' and reserve_created_at is null;

alter table public.timetable_assignments
  alter column reserve_created_at set default now();

create or replace function public.replace_timetable_substitution_with_reason(p_payload jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp
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
begin
  if v_assignment_id is null or v_actor_name='' or v_actor_type not in ('admin','teacher','custom') or v_substitute_name='' then
    raise exception 'بيانات تعديل تكليف الاحتياط غير مكتملة.';
  end if;
  select * into v_old from public.timetable_assignments
    where id=v_assignment_id and assignment_type='substitution' for update;
  if not found then raise exception 'تكليف الاحتياط المطلوب غير موجود.'; end if;
  if v_old.status not in ('assigned','confirmed') then raise exception 'لا يمكن تعديل تكليف مكتمل أو ملغى.'; end if;
  if coalesce(v_old.reserve_created_at,v_old.created_at) <= now() - interval '20 hours' then
    raise exception 'انتهت مهلة تعديل سجل الاحتياط؛ أصبح السجل في الأرشيف للقراءة فقط.';
  end if;

  v_cancel:=public.cancel_timetable_substitution(jsonb_build_object(
    'assignment_id',v_assignment_id,'actor_name',v_actor_name,'actor_type',v_actor_type
  ));
  v_created:=public.create_timetable_substitution_with_reason(jsonb_build_object(
    'version_id',v_old.version_id,'weekday',v_old.weekday,'period',v_old.period,'assignment_date',v_old.assignment_date,
    'absent_teacher_name',v_old.absent_teacher_name,'substitute_teacher_name',v_substitute_name,
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

revoke all on function public.replace_timetable_substitution_with_reason(jsonb) from public, anon, authenticated;
grant execute on function public.replace_timetable_substitution_with_reason(jsonb) to service_role;
