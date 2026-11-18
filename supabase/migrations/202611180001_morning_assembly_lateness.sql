-- Morning assembly lateness: isolated append-only event ledger.
-- This migration intentionally does not modify attendance, behaviors, students, or teachers.
create table if not exists public.morning_assembly_lateness (
  id uuid primary key default gen_random_uuid(),
  student_id bigint references public.students(id) on delete set null,
  student_name_snapshot text not null check (length(btrim(student_name_snapshot)) > 0),
  class_name_snapshot text not null check (length(btrim(class_name_snapshot)) > 0),
  late_date date not null,
  recorded_at timestamptz not null default now(),
  recorder_type text not null check (recorder_type in ('admin','teacher','custom')),
  recorder_name text not null check (length(btrim(recorder_name)) > 0),
  academic_year text not null check (academic_year ~ '^[0-9]{4}/[0-9]{4}$'),
  constraint morning_assembly_lateness_student_day_unique unique (student_id, late_date)
);
create index if not exists morning_assembly_lateness_year_date_idx
  on public.morning_assembly_lateness (academic_year, late_date desc);
create index if not exists morning_assembly_lateness_student_year_idx
  on public.morning_assembly_lateness (student_id, academic_year, late_date desc);
alter table public.morning_assembly_lateness enable row level security;
revoke all on public.morning_assembly_lateness from anon, authenticated;
grant select, insert on public.morning_assembly_lateness to service_role;
comment on table public.morning_assembly_lateness is
  'Append-only morning assembly lateness ledger. Kept separate from attendance; one event per student per Oman-local date.';
