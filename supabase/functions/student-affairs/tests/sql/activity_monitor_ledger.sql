begin;

do $$
begin
  if not exists (
    select 1 from pg_class
    where oid = 'public.student_affairs_activity_events'::regclass
      and relrowsecurity
  ) then
    raise exception 'Activity event table must have RLS enabled';
  end if;
  if has_table_privilege('anon', 'public.student_affairs_activity_events', 'SELECT')
    or has_table_privilege('authenticated', 'public.student_affairs_activity_events', 'SELECT')
    or has_table_privilege('anon', 'public.student_affairs_activity_events', 'INSERT')
    or has_table_privilege('authenticated', 'public.student_affairs_activity_events', 'INSERT') then
    raise exception 'Public and authenticated roles must not access the activity ledger';
  end if;
  if not has_table_privilege('service_role', 'public.student_affairs_activity_events', 'SELECT')
    or not has_table_privilege('service_role', 'public.student_affairs_activity_events', 'INSERT')
    or has_table_privilege('service_role', 'public.student_affairs_activity_events', 'UPDATE')
    or has_table_privilege('service_role', 'public.student_affairs_activity_events', 'DELETE') then
    raise exception 'Service role must have append-only SELECT and INSERT access';
  end if;
  if not has_sequence_privilege('service_role', 'public.student_affairs_activity_events_id_seq', 'USAGE') then
    raise exception 'Service role must be able to generate activity event IDs';
  end if;
  if not exists (select 1 from public.student_affairs_activity_settings where id = true) then
    raise exception 'Activity tracking start timestamp must be initialized';
  end if;
end;
$$;

insert into public.student_affairs_notice_issues (
  class_name, student_name, issue_number, issued_on, issued_by_type, issued_by_name,
  delivered, delivered_at, threshold, period_start, period_end, selected_types, events
) values (
  'activity-monitor-test-class',
  'activity-monitor-test-student',
  1,
  current_date,
  'teacher',
  'activity-monitor-test-teacher',
  false,
  null,
  1,
  null,
  current_date,
  '["late"]'::jsonb,
  '[{"type":"late","date":"2026-11-23","period":"1","note":"isolated audit test"}]'::jsonb
);

do $$
begin
  if (
    select count(*) from public.student_affairs_activity_events
    where actor_name = 'activity-monitor-test-teacher'
      and event_type = 'formal_warning_issued'
      and metadata->>'student_name' = 'activity-monitor-test-student'
  ) <> 1 then
    raise exception 'An official notice insert must create exactly one audit event';
  end if;
end;
$$;

rollback;
