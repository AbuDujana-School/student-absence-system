create table if not exists public.student_affairs_activity_settings (
  id boolean primary key default true check (id),
  tracking_started_at timestamptz not null default now()
);

insert into public.student_affairs_activity_settings (id)
values (true)
on conflict (id) do nothing;

create table if not exists public.student_affairs_activity_events (
  id bigint generated always as identity primary key,
  actor_type text not null check (actor_type in ('admin', 'teacher', 'custom')),
  actor_name text not null check (length(trim(actor_name)) > 0),
  event_type text not null check (event_type in (
    'student_affairs_open',
    'absence_report_view',
    'behavior_report_view',
    'formal_warning_issued'
  )),
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists student_affairs_activity_actor_time_idx
  on public.student_affairs_activity_events (actor_name, occurred_at desc);
create index if not exists student_affairs_activity_type_time_idx
  on public.student_affairs_activity_events (event_type, occurred_at desc);

alter table public.student_affairs_activity_settings enable row level security;
alter table public.student_affairs_activity_events enable row level security;

revoke all on public.student_affairs_activity_settings from anon, authenticated;
revoke all on public.student_affairs_activity_events from anon, authenticated;
grant select on public.student_affairs_activity_settings to service_role;
grant select, insert on public.student_affairs_activity_events to service_role;

create or replace function public.log_student_affairs_notice_activity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if nullif(trim(new.issued_by_name), '') is not null then
    insert into public.student_affairs_activity_events (
      actor_type, actor_name, event_type, occurred_at, metadata
    ) values (
      case when new.issued_by_type in ('admin', 'teacher', 'custom') then new.issued_by_type else 'teacher' end,
      new.issued_by_name,
      'formal_warning_issued',
      coalesce(new.issued_at, now()),
      jsonb_build_object(
        'notice_id', new.id,
        'class_name', new.class_name,
        'student_name', new.student_name,
        'issue_number', new.issue_number,
        'issued_on', new.issued_on,
        'delivered', new.delivered
      )
    );
  end if;
  return new;
end;
$$;

revoke all on function public.log_student_affairs_notice_activity() from public, anon, authenticated;

drop trigger if exists student_affairs_notice_activity_audit on public.student_affairs_notice_issues;
create trigger student_affairs_notice_activity_audit
after insert on public.student_affairs_notice_issues
for each row execute function public.log_student_affairs_notice_activity();

comment on table public.student_affairs_activity_events is
  'Append-only audit events for Student Affairs usage monitoring; access is restricted to the service role.';
comment on table public.student_affairs_activity_settings is
  'Stores the start timestamp for Student Affairs activity monitoring.';

-- The edge function inserts events without supplying the identity column.
grant usage, select on sequence public.student_affairs_activity_events_id_seq to service_role;
