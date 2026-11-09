create table if not exists public.student_affairs_login_attempts (
  client_key text primary key,
  window_started_at timestamptz not null default now(),
  failed_attempts integer not null default 0,
  blocked_until timestamptz
);
alter table public.student_affairs_login_attempts enable row level security;
revoke all on public.student_affairs_login_attempts from anon, authenticated;
grant all on public.student_affairs_login_attempts to service_role;
