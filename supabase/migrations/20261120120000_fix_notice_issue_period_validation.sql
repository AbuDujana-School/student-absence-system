-- Align the notice ledger's monitoring-window validation with the API contract.
-- The monitoring period ends on or before the issuance date. This migration changes
-- only the RPC validation; it does not update or delete existing notice records.
create or replace function public.issue_student_affairs_notices(p_items jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  v_item jsonb;
  v_result jsonb := '[]'::jsonb;
  v_row public.student_affairs_notice_issues%rowtype;
  v_class text;
  v_student text;
  v_next_number integer;
  v_delivered boolean;
  v_last_issued_on date;
  v_new_events jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 1000 then
    raise exception 'Invalid notice batch';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_class := btrim(coalesce(v_item->>'class_name', ''));
    v_student := btrim(coalesce(v_item->>'student_name', ''));
    v_delivered := coalesce((v_item->>'delivered')::boolean, false);

    if v_class = '' or v_student = ''
      or coalesce(v_item->>'issued_by_name', '') = ''
      or coalesce(v_item->>'issued_by_type', '') not in ('admin', 'teacher', 'custom')
      or jsonb_typeof(v_item->'events') <> 'array'
      or jsonb_array_length(v_item->'events') < 1
      or jsonb_typeof(v_item->'selected_types') <> 'array'
      or (v_item->>'threshold')::integer not between 1 and 10
      or (v_item->>'period_end')::date > (v_item->>'issued_on')::date then
      raise exception 'Invalid notice item';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_class || chr(31) || v_student, 0));

    select max(issued_on)
      into v_last_issued_on
      from public.student_affairs_notice_issues
      where class_name = v_class and student_name = v_student;

    select coalesce(jsonb_agg(candidate.event), '[]'::jsonb)
      into v_new_events
      from jsonb_array_elements(v_item->'events') as candidate(event)
      where (v_last_issued_on is null or (candidate.event->>'date')::date > v_last_issued_on)
        and not exists (
          select 1
            from public.student_affairs_notice_issues prior
            cross join lateral jsonb_array_elements(prior.events) as old(event)
           where prior.class_name = v_class
             and prior.student_name = v_student
             and old.event->>'type' = candidate.event->>'type'
             and old.event->>'date' = candidate.event->>'date'
             and old.event->>'period' = candidate.event->>'period'
             and coalesce(old.event->>'note', '') = coalesce(candidate.event->>'note', '')
        );

    if jsonb_array_length(v_new_events) < (v_item->>'threshold')::integer then
      continue;
    end if;

    select coalesce(max(issue_number), 0) + 1
      into v_next_number
      from public.student_affairs_notice_issues
      where class_name = v_class and student_name = v_student;

    insert into public.student_affairs_notice_issues (
      class_name, student_name, issue_number, issued_on, issued_by_type, issued_by_name,
      delivered, delivered_at, threshold, period_start, period_end, selected_types, events
    ) values (
      v_class, v_student, v_next_number, (v_item->>'issued_on')::date,
      v_item->>'issued_by_type', btrim(v_item->>'issued_by_name'),
      v_delivered, case when v_delivered then now() else null end,
      (v_item->>'threshold')::smallint,
      case when v_last_issued_on is null then nullif(v_item->>'period_start', '')::date else v_last_issued_on + 1 end,
      (v_item->>'period_end')::date,
      v_item->'selected_types', v_new_events
    )
    returning * into v_row;

    v_result := v_result || jsonb_build_array(to_jsonb(v_row));
  end loop;

  return v_result;
end;
$function$;

revoke all on function public.issue_student_affairs_notices(jsonb) from public, anon, authenticated;
grant execute on function public.issue_student_affairs_notices(jsonb) to service_role;

comment on function public.issue_student_affairs_notices(jsonb) is
  'Atomically issues official notices. The monitoring period must end on or before issuance; per-student advisory locks prevent duplicate concurrent issues. Service-role only.';
