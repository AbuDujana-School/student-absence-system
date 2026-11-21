-- A same-day removal of a complete absent-teacher distribution must reverse every point,
-- including assignments whose original approval is older than the normal 14-hour correction window.
CREATE OR REPLACE FUNCTION public.cancel_timetable_substitution_batch(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_items jsonb := p_payload->'assignment_ids';
  v_actor_name text := left(btrim(coalesce(p_payload->>'actor_name','')),160);
  v_actor_type text := coalesce(p_payload->>'actor_type','');
  v_first public.timetable_assignments%rowtype;
  v_assignment public.timetable_assignments%rowtype;
  v_assignment_id uuid;
  v_item text;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if v_actor_name='' or v_actor_type not in ('admin','teacher','custom') then
    raise exception 'بيانات حذف توزيع الاحتياط غير صالحة.';
  end if;
  if coalesce(jsonb_typeof(v_items),'')<>'array' then
    raise exception 'قائمة تكليفات الاحتياط غير صالحة.';
  end if;
  if jsonb_array_length(v_items)<1 or jsonb_array_length(v_items)>500 then
    raise exception 'حدد من تكليف واحد إلى 500 تكليف لحذف التوزيع.';
  end if;
  if (select count(distinct value) from jsonb_array_elements_text(v_items))<>jsonb_array_length(v_items) then
    raise exception 'تحتوي قائمة الحذف على تكليفات مكررة.';
  end if;

  v_assignment_id:=nullif(v_items->>0,'')::uuid;
  if v_assignment_id is null then raise exception 'رقم تكليف الاحتياط غير صالح.'; end if;
  select * into v_first from public.timetable_assignments
    where id=v_assignment_id and assignment_type='substitution' for update;
  if not found then raise exception 'تكليف الاحتياط غير موجود.'; end if;

  for v_item in select value from jsonb_array_elements_text(v_items)
  loop
    v_assignment_id:=nullif(v_item,'')::uuid;
    if v_assignment_id is null then raise exception 'رقم تكليف الاحتياط غير صالح.'; end if;
    select * into v_assignment from public.timetable_assignments
      where id=v_assignment_id and assignment_type='substitution' for update;
    if not found then raise exception 'تعذر العثور على أحد تكليفات التوزيع.'; end if;
    if v_assignment.absent_teacher_name is distinct from v_first.absent_teacher_name
      or v_assignment.assignment_date is distinct from v_first.assignment_date
      or v_assignment.weekday is distinct from v_first.weekday then
      raise exception 'يجب أن تضم عملية الحذف حصص توزيع معلم غائب واحد في تاريخ واحد فقط.';
    end if;
    v_result:=public.cancel_timetable_substitution(jsonb_build_object(
      'assignment_id',v_assignment_id,'actor_name',v_actor_name,'actor_type',v_actor_type,
      'force_points_reversal',true
    ));
    v_results:=v_results||jsonb_build_array(v_result);
    v_count:=v_count+1;
  end loop;
  return jsonb_build_object('ok',true,'cancelled_count',v_count,'assignments',v_results,'atomic',true);
end;
$function$;

