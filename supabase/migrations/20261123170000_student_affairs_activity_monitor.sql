-- Auditable activity history for Student Affairs teacher performance monitoring.
create table if not exists public.student_affairs_activity_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in (
    'module_access',
    'absence_report_view',
    'behavior_report_view',
    'formal_warning_issued',
    'formal_warning_print'
  )),
  actor_type text not null check (actor_type in ('admin','teacher','custom')),
  actor_name text not null check (length(trim(actor_name)) > 0),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists student_affairs_activity_events_actor_created_idx
  on public.student_affairs_activity_events (actor_name, created_at desc);
create index if not exists student_affairs_activity_events_type_created_idx
  on public.student_affairs_activity_events (event_type, created_at desc);

alter table public.student_affairs_activity_events enable row level security;
revoke all on public.student_affairs_activity_events from public, anon, authenticated;
grant select, insert on public.student_affairs_activity_events to service_role;

comment on table public.student_affairs_activity_events is
  'Append-only audit trail for Student Affairs module access, report views, and official warning issuance/printing. Tracking starts when this migration is deployed.';
