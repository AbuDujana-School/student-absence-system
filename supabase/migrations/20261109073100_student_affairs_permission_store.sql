create table if not exists public.student_affairs_permissions (
  principal_type text not null check (principal_type in ('admin','teacher','custom')),
  principal_name text not null,
  allowed_classes text[] not null default '{}',
  can_read_attendance boolean not null default false,
  can_read_behavior boolean not null default false,
  can_view_analytics boolean not null default false,
  can_print_attendance boolean not null default false,
  can_print_behavior boolean not null default false,
  can_print_combined boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (principal_type, principal_name)
);
alter table public.student_affairs_permissions enable row level security;
revoke all on public.student_affairs_permissions from anon, authenticated;
grant all on public.student_affairs_permissions to service_role;
