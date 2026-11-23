-- Central, append-only activity ledger for Student Affairs performance monitoring.
-- No existing teacher, attendance, behavior, or official-notice records are modified.
create table if not exists public.student_affairs_activity_events (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('admin', 'teacher', 'custom')),
  actor_name text not null check (length(btrim(actor_name)) > 0),
  event_type text not null check (event_type in (
    'section_access',
    'absence_report_view',
    'behavior_report_view',
    'official_warning_print'
  )),
  occurred_at timestamptz not null default now(),
  quantity integer not null default 1 check (quantity > 0),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);
create index if not exists student_affairs_activity_actor_time_idx
  on public.student_affairs_activity_events (actor_name, occurred_at desc);
create index if not exists student_affairs_activity_time_idx
  on public.student_affairs_activity_events (occurred_at desc);
alter table public.student_affairs_activity_events enable row level security;
revoke all on table public.student_affairs_activity_events from public, anon, authenticated, service_role;
grant select, insert on table public.student_affairs_activity_events to service_role;
comment on table public.student_affairs_activity_events is
  'Service-role-only audit ledger for Student Affairs section access, report views, and official warning print requests. No preview or draft warning event is stored.';
