-- Cumulative substitution fairness: exact period weights, daily load multiplier and emergency compensation.
-- Additive ledger evolution only. Existing assignments and audit rows are retained.
alter table public.timetable_substitution_points_ledger
  alter column points_delta type numeric(10,2)
  using points_delta::numeric(10,2);

create or replace function public.timetable_substitution_period_weight(p_period integer)
returns numeric(6,2)
language sql immutable parallel safe set search_path = pg_catalog
as $function$
  select case p_period
    when 1 then 1.00 when 2 then 1.00
    when 3 then 1.50 when 4 then 1.50
    when 5 then 3.00 when 6 then 2.50
    when 7 then 4.00 when 8 then 5.00
    else 0.00 end;
$function$;
revoke all on function public.timetable_substitution_period_weight(integer) from public,anon,authenticated;
grant execute on function public.timetable_substitution_period_weight(integer) to service_role;

-- Recalculate historical coverage credits using the approved period weight and
-- the teacher's recorded teaching load for that timetable day.
update public.timetable_substitution_points_ledger l
set points_delta=round(
  public.timetable_substitution_period_weight(a.period::integer) *
  case when coalesce(load.teaching_count,0)<=2 then 1.00
       when load.teaching_count=3 then 1.25
       when load.teaching_count=4 then 1.60
       else 2.20 end, 2
)
from public.timetable_assignments a
left join lateral (
  select count(distinct c.period)::integer as teaching_count
  from public.timetable_weekly_cells c
  where c.version_id=a.version_id
    and c.matched_teacher_name=a.teacher_name
    and c.weekday=a.weekday
    and c.cell_status='teaching'
) load on true
where l.assignment_id=a.id
  and l.event_key='assignment:'||a.id::text||':coverage'
  and a.assignment_type='substitution';

-- Keep prior reversal rows exactly opposite their corresponding original effort credit.
update public.timetable_substitution_points_ledger reversal
set points_delta=-coverage.points_delta
from public.timetable_substitution_points_ledger coverage
where reversal.assignment_id=coverage.assignment_id
  and reversal.event_key='assignment:'||coverage.assignment_id::text||':coverage-reversal'
  and coverage.event_key='assignment:'||coverage.assignment_id::text||':coverage';

create or replace function public.record_timetable_substitution_points()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_assignment public.timetable_assignments%rowtype;
  v_teaching_count integer := 0;
  v_load_factor numeric(6,2) := 1.00;
  v_points numeric(10,2) := 0;
  v_emergency_net numeric(10,2) := 0;
  v_remaining_assignments integer := 0;
  v_emergency_prefix text;
begin
  if TG_OP='INSERT' or (TG_OP='UPDATE' and NEW.status in ('assigned','confirmed','completed')) then
    v_assignment:=NEW;
    if v_assignment.assignment_type='substitution'
      and v_assignment.status in ('assigned','confirmed','completed') then
      select count(distinct c.period)::integer into v_teaching_count
      from public.timetable_weekly_cells c
      where c.version_id=v_assignment.version_id
        and c.matched_teacher_name=v_assignment.teacher_name
        and c.weekday=v_assignment.weekday
        and c.cell_status='teaching';

      v_load_factor:=case
        when v_teaching_count<=2 then 1.00
        when v_teaching_count=3 then 1.25
        when v_teaching_count=4 then 1.60
        else 2.20 end;
      v_points:=round(public.timetable_substitution_period_weight(v_assignment.period::integer)*v_load_factor,2);

      if v_points>0 then
        insert into public.timetable_substitution_points_ledger(
          assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name
        ) values (
          v_assignment.id,v_assignment.teacher_name,
          'assignment:'||v_assignment.id::text||':coverage',
          'coverage_credit',v_points,v_assignment.period,v_assignment.weekday,
          v_assignment.assignment_date,v_assignment.absent_teacher_name
        ) on conflict(event_key) do nothing;
      end if;

      -- A sudden/emergency absence gives the returning teacher a +2 priority balance.
      -- It is awarded once per absent-teacher/date, not once per covered lesson.
      if nullif(btrim(coalesce(v_assignment.absent_teacher_name,'')),'') is not null
        and coalesce(v_assignment.absence_reason,'') ilike '%طارئ%'
        and v_assignment.assignment_date is not null then
        v_emergency_prefix:='absence-emergency:'||v_assignment.absent_teacher_name||':'||v_assignment.assignment_date::text||':';
        select coalesce(sum(points_delta),0) into v_emergency_net
        from public.timetable_substitution_points_ledger
        where teacher_name=v_assignment.absent_teacher_name
          and event_key like v_emergency_prefix||'%';
        if v_emergency_net<2.00 then
          insert into public.timetable_substitution_points_ledger(
            assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name
          ) values (
            v_assignment.id,v_assignment.absent_teacher_name,
            v_emergency_prefix||'credit:'||gen_random_uuid()::text,
            'coverage_credit',round(2.00-v_emergency_net,2),v_assignment.period,
            v_assignment.weekday,v_assignment.assignment_date,v_assignment.absent_teacher_name
          );
        end if;
      end if;
    end if;
  end if;

  -- Reversals are reserved for the existing explicit replacement/reset pathway.
  if TG_OP='UPDATE'
    and OLD.assignment_type='substitution'
    and OLD.status in ('assigned','confirmed','completed')
    and NEW.status='cancelled'
    and coalesce(current_setting('app.force_substitution_points_reversal',true),'false')='true' then
    select coalesce(sum(points_delta),0) into v_points
    from public.timetable_substitution_points_ledger
    where assignment_id=OLD.id
      and event_key='assignment:'||OLD.id::text||':coverage';
    if v_points>0 and not exists(
      select 1 from public.timetable_substitution_points_ledger
      where event_key='assignment:'||OLD.id::text||':coverage-reversal'
    ) then
      insert into public.timetable_substitution_points_ledger(
        assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name
      ) values (
        OLD.id,OLD.teacher_name,'assignment:'||OLD.id::text||':coverage-reversal',
        'coverage_reversal',-v_points,OLD.period,OLD.weekday,OLD.assignment_date,OLD.absent_teacher_name
      ) on conflict(event_key) do nothing;
    end if;

    if nullif(btrim(coalesce(OLD.absent_teacher_name,'')),'') is not null
      and coalesce(OLD.absence_reason,'') ilike '%طارئ%'
      and OLD.assignment_date is not null then
      select count(*) into v_remaining_assignments
      from public.timetable_assignments a
      where a.assignment_type='substitution'
        and a.absent_teacher_name=OLD.absent_teacher_name
        and a.assignment_date=OLD.assignment_date
        and a.status in ('assigned','confirmed','completed');
      if v_remaining_assignments=0 then
        v_emergency_prefix:='absence-emergency:'||OLD.absent_teacher_name||':'||OLD.assignment_date::text||':';
        select coalesce(sum(points_delta),0) into v_emergency_net
        from public.timetable_substitution_points_ledger
        where teacher_name=OLD.absent_teacher_name
          and event_key like v_emergency_prefix||'%';
        if v_emergency_net>0 then
          insert into public.timetable_substitution_points_ledger(
            assignment_id,teacher_name,event_key,event_type,points_delta,period,weekday,assignment_date,absent_teacher_name
          ) values (
            OLD.id,OLD.absent_teacher_name,
            v_emergency_prefix||'reversal:'||gen_random_uuid()::text,
            'coverage_reversal',-v_emergency_net,OLD.period,OLD.weekday,
            OLD.assignment_date,OLD.absent_teacher_name
          );
        end if;
      end if;
    end if;
  end if;

  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end;
$function$;

revoke all on function public.record_timetable_substitution_points() from public,anon,authenticated;
grant execute on function public.record_timetable_substitution_points() to service_role;
