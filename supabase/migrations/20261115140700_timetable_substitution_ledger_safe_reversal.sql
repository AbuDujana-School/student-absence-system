create or replace function public.record_timetable_substitution_points()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $function$
declare
  v_assignment public.timetable_assignments%rowtype;
  v_points integer;
  v_coverage_event_exists boolean := false;
  v_absence_event_exists boolean := false;
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
      select exists(select 1 from public.timetable_substitution_points_ledger
        where assignment_id=OLD.id and event_key='assignment:'||OLD.id::text||':coverage') into v_coverage_event_exists;
      if v_coverage_event_exists then
        insert into public.timetable_substitution_points_ledger(assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name)
        values(OLD.id,OLD.teacher_name,'assignment:'||OLD.id::text||':coverage-reversal','coverage_reversal',-v_points,OLD.period,OLD.weekday,OLD.assignment_date,OLD.absent_teacher_name)
        on conflict(event_key) do nothing;
      end if;
      if nullif(btrim(coalesce(OLD.absent_teacher_name,'')),'') is not null then
        select exists(select 1 from public.timetable_substitution_points_ledger
          where assignment_id=OLD.id and event_key='assignment:'||OLD.id::text||':absence') into v_absence_event_exists;
        if v_absence_event_exists then
          insert into public.timetable_substitution_points_ledger(assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name)
          values(OLD.id,OLD.absent_teacher_name,'assignment:'||OLD.id::text||':absence-reversal','absence_reversal',v_points,OLD.period,OLD.weekday,OLD.assignment_date,OLD.absent_teacher_name)
          on conflict(event_key) do nothing;
        end if;
      end if;
    end if;
  end if;
  return NEW;
end;
$function$;