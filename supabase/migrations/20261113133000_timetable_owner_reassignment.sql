-- Preserve workbook source teacher names while allowing an administrator to assign
-- each imported timetable owner to an existing teacher account.
alter table public.timetable_import_audit
  drop constraint if exists timetable_import_audit_action_check;
alter table public.timetable_import_audit
  add constraint timetable_import_audit_action_check
  check (action in ('import_created','record_updated','record_added','record_deleted','status_changed','reimport_compared','owner_reassigned'));

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
  v_import_teacher public.timetable_import_teachers%rowtype;
  v_target record;
  v_old_owner text;
  v_old_status text;
  v_source_count integer;
begin
  if v_import_id is null or v_source_name = '' or v_actor = '' then
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
    v_import_id, 'owner_reassigned', 'admin', v_actor,
    jsonb_build_object('source_name',v_source_name,'owner',v_old_owner,'match_status',v_old_status),
    jsonb_build_object('source_name',v_source_name,'owner',nullif(v_teacher_name,''),'match_status',case when v_teacher_name='' then 'unmatched' else 'matched' end)
  );

  return jsonb_build_object('ok',true,'source_name',v_source_name,'matched_teacher_name',nullif(v_teacher_name,''));
end;
$function$;

revoke all on function public.reassign_timetable_import_owner(jsonb) from public, anon, authenticated;
grant execute on function public.reassign_timetable_import_owner(jsonb) to service_role;
