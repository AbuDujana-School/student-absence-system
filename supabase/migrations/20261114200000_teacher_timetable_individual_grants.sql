-- Individual teacher access to the personal timetable portal.
-- Additive: no teacher, timetable, credential, or existing permission records are changed.
create table if not exists public.teacher_timetable_portal_grants (
  teacher_name text primary key,
  active boolean not null default true,
  granted_by text not null,
  granted_at timestamptz not null default now(),
  revoked_by text,
  revoked_at timestamptz
);

create index if not exists teacher_timetable_portal_grants_active_idx
  on public.teacher_timetable_portal_grants (active, teacher_name);

alter table public.teacher_timetable_portal_grants enable row level security;
revoke all on table public.teacher_timetable_portal_grants from public, anon, authenticated;
grant all on table public.teacher_timetable_portal_grants to service_role;
