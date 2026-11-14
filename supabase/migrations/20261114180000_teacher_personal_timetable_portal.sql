-- Teacher personal timetable portal.
-- Additive and intentionally disabled by default; does not alter timetable or teacher records.
create table if not exists public.teacher_timetable_portal_settings (
  id boolean primary key default true check (id = true),
  enabled boolean not null default false,
  updated_by text,
  updated_at timestamptz not null default now()
);

insert into public.teacher_timetable_portal_settings (id, enabled)
values (true, false)
on conflict (id) do nothing;

alter table public.teacher_timetable_portal_settings enable row level security;
revoke all on table public.teacher_timetable_portal_settings from public, anon, authenticated;
grant all on table public.teacher_timetable_portal_settings to service_role;
